/**
 * Run namespace tests - verifies composition helpers against the scope engine.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
  run,
  createContextKey,
  group,
  CancellationError,
  TimeoutError,
  WorkAggregateError,
} from "../../dist/index.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

test("run.all preserves result order and cancels siblings on failure", async () => {
  let slowCancelled = false;

  await assert.rejects(
    run.all([
      async () => "a",
      async () => {
        await sleep(20);
        throw new Error("boom");
      },
      async (ctx) => {
        try {
          await sleep(1000, ctx.signal);
          return "never";
        } catch (err) {
          slowCancelled = err instanceof CancellationError
            && err.reason.kind === "sibling_failed";
          throw err;
        }
      },
    ]),
    /boom/
  );

  assert.equal(slowCancelled, true);
  assert.deepEqual(await run.all([async () => "x", async () => "y"]), ["x", "y"]);
});

test("run.race returns first settlement and cancels losers", async () => {
  let loserCancelled = false;

  const result = await run.race([
    async (ctx) => {
      try {
        await sleep(1000, ctx.signal);
        return "slow";
      } catch (err) {
        loserCancelled = err instanceof CancellationError
          && err.reason.kind === "race_lost";
        throw err;
      }
    },
    async () => "fast",
  ]);

  assert.equal(result, "fast");
  assert.equal(loserCancelled, true);
});

test("run.any returns first success and rejects with aggregate when all fail", async () => {
  const result = await run.any([
    async () => { throw new Error("a"); },
    async () => "ok",
    async () => { throw new Error("b"); },
  ]);

  assert.equal(result, "ok");
  await assert.rejects(
    run.any([async () => { throw new Error("a"); }]),
    WorkAggregateError
  );
});

test("run.any preserves the parent scope cancellation reason", async () => {
  await assert.rejects(
    group(async (task) => {
      let scope;
      await task(async (ctx) => {
        scope = ctx.scope;
      });

      const handle = task(async () => run.any([
        async (ctx) => {
          await sleep(1_000, ctx.signal);
          return "late-a";
        },
        async (ctx) => {
          await sleep(1_000, ctx.signal);
          return "late-b";
        },
      ]));

      await sleep(5);
      scope.cancel("any-parent-cancel");
      await handle;
    }),
    (err) => err instanceof CancellationError
      && err.reason.kind === "manual"
      && err.reason.tag === "any-parent-cancel"
  );
});

test("run.retry retries non-cancellation failures and respects times", async () => {
  let attempts = 0;
  const flaky = run.retry(async () => {
    attempts++;
    if (attempts < 3) throw new Error("try again");
    return "done";
  }, { times: 3, initialDelay: 1, maxDelay: 1, jitter: false });

  assert.equal(await run.group(async (task) => task(flaky)), "done");
  assert.equal(attempts, 3);
});

test("run.timeout rejects with TimeoutError", async () => {
  await assert.rejects(
    run.group(async (task) => task(run.timeout(async (ctx) => {
      await sleep(1000, ctx.signal);
      return "late";
    }, 10))),
    TimeoutError
  );
});

test("run.deadline rejects when the deadline is reached", async () => {
  await assert.rejects(
    run.group(async (task) => task(run.deadline(async (ctx) => {
      await sleep(1000, ctx.signal);
      return "late";
    }, Date.now() + 10))),
    TimeoutError
  );
});

test("run.pool enforces concurrency and preserves order", async () => {
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(10);
    active--;
    return index;
  });

  assert.deepEqual(await run.pool(2, tasks), [0, 1, 2, 3, 4, 5]);
  assert.equal(maxActive, 2);
});

test("run.context.with binds context to nested work", async () => {
  const User = createContextKey("User");
  const value = await run.context.with(User, "Admilson", async () => {
    return await run.group(async (task) => task(async () => run.context.get(User)));
  });

  assert.equal(value, "Admilson");
});

test("run.fallback uses secondary task after primary failure", async () => {
  const wrapped = run.fallback(
    async () => { throw new Error("primary failed"); },
    async () => "secondary"
  );

  assert.equal(await run.group(async (task) => task(wrapped)), "secondary");
});

test("run.hedge starts delayed attempts only while unsettled", async () => {
  let attempts = 0;

  const wrapped = run.hedge(async () => {
    attempts++;
    return "first";
  }, { after: 20, max: 3 });

  assert.equal(await run.group(async (task) => task(wrapped)), "first");
  await sleep(60);
  assert.equal(attempts, 1);
});

test("run.circuitBreaker opens after repeated failures and recovers after reset", async () => {
  let calls = 0;
  const wrapped = run.circuitBreaker(async () => {
    calls++;
    if (calls <= 2) throw new Error("backend down");
    return "ok";
  }, { failureThreshold: 2, resetAfter: 20 });

  await assert.rejects(run.group(async (task) => task(wrapped)), /backend down/);
  await assert.rejects(run.group(async (task) => task(wrapped)), /backend down/);
  await assert.rejects(run.group(async (task) => task(wrapped)), /Circuit breaker is open/);
  await sleep(30);
  assert.equal(await run.group(async (task) => task(wrapped)), "ok");
});

test("run.circuitBreaker admits one half-open probe under concurrent pressure", async () => {
  let probes = 0;
  const wrapped = run.circuitBreaker(async (ctx) => {
    probes++;
    if (probes === 1) throw new Error("open breaker");
    await sleep(20, ctx.signal);
    return "probe-ok";
  }, { failureThreshold: 1, resetAfter: 1, halfOpenMaxCalls: 1 });

  await assert.rejects(run.group(async (task) => task(wrapped)), /open breaker/);
  await sleep(5);

  const settled = await run.allSettled(Array.from({ length: 100 }, () => wrapped));
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 99);
  assert.equal(probes, 2);
});

test("run.background requires a scope and keeps work owned by that scope", async () => {
  await assert.rejects(
    async () => run.background(async () => "outside"),
    /requires an active WorkJS scope/
  );

  let completed = false;
  await run.group(async () => {
    run.background(async (ctx) => {
      await sleep(20, ctx.signal);
      completed = true;
    });
  });

  assert.equal(completed, true);
});

test("run.detached does not delay the active scope", async () => {
  let completed = false;
  let handle;
  const start = Date.now();

  await run.group(async () => {
    handle = run.detached(async () => {
      await sleep(80);
      completed = true;
    });
  });

  assert.ok(Date.now() - start < 70);
  assert.equal(completed, false);
  await handle;
  assert.equal(completed, true);
});

test("run.supervise restarts failures within the restart window", async () => {
  let attempts = 0;
  const handle = run.supervise(async () => {
    attempts++;
    if (attempts < 3) throw new Error("restart me");
    return "stable";
  }, { maxRestarts: 3, backoff: () => 1 });

  assert.equal(await handle, "stable");
  assert.equal(attempts, 3);
});

test("task options support idempotency retry timeout deadline and retry events", async () => {
  let executions = 0;
  let idempotentExecutions = 0;
  const events = [];

  const result = await run.group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((event) => events.push(event));
    }, { name: "observer" });

    const first = task(async () => {
      idempotentExecutions++;
      return "same-result";
    }, { name: "same-a", idempotencyKey: "upload:1" });

    const second = task(async () => {
      idempotentExecutions++;
      return "wrong-result";
    }, { name: "same-b", idempotencyKey: "upload:1" });

    const retried = task(async () => {
      executions++;
      if (executions < 2) throw new Error("retry task option");
      return "retried";
    }, {
      name: "retried",
      retry: { times: 2, initialDelay: 1, maxDelay: 1, jitter: false },
    });

    return [await first, await second, await retried];
  });

  assert.deepEqual(result, ["same-result", "same-result", "retried"]);
  assert.equal(idempotentExecutions, 1);
  assert.equal(executions, 2);
  assert.ok(events.some((event) => event.type === "task:retrying" && event.attempt === 2));

  const afterSettlement = await taskAfterIdempotencySettlement();
  assert.deepEqual(afterSettlement, ["after-first", "after-second"]);

  await assert.rejects(
    run.group(async (task) => task(async (ctx) => {
      await sleep(50, ctx.signal);
    }, { timeout: 1 })),
    TimeoutError
  );

  await assert.rejects(
    run.group(async (task) => task(async (ctx) => {
      await sleep(50, ctx.signal);
    }, { deadline: Date.now() + 1 })),
    TimeoutError
  );

  await assert.rejects(
    run.group(async (task) => task(async (ctx) => {
      await sleep(50, ctx.signal);
    }, { deadline: new Date(Date.now() + 1) })),
    TimeoutError
  );
});

async function taskAfterIdempotencySettlement() {
  const executions = [];
  return await run.group(async (task) => {
    const first = await task(async () => {
      executions.push("after-first");
      return "first";
    }, { idempotencyKey: "upload:after-settlement" });

    const second = await task(async () => {
      executions.push("after-second");
      return "second";
    }, { idempotencyKey: "upload:after-settlement" });

    assert.deepEqual([first, second], ["first", "second"]);
    return executions;
  });
}

test("task option retry policies cover cancel-aware delay and backoff branches", async () => {
  let fixedAttempts = 0;
  assert.equal(await run.group(async (task) => task(async () => {
    fixedAttempts++;
    if (fixedAttempts < 2) throw new Error("fixed retry");
    return "fixed";
  }, {
    retry: { times: 2, backoff: "fixed", initialDelay: 1, maxDelay: 1, jitter: false },
  })), "fixed");

  let numericAttempts = 0;
  assert.equal(await run.group(async (task) => task(async () => {
    numericAttempts++;
    if (numericAttempts < 2) throw new Error("numeric retry");
    return "numeric";
  }, { retry: 2 })), "numeric");

  let linearAttempts = 0;
  assert.equal(await run.group(async (task) => task(async () => {
    linearAttempts++;
    if (linearAttempts < 2) throw new Error("linear retry");
    return "linear";
  }, {
    retry: { times: 2, backoff: "linear", initialDelay: 1, maxDelay: 1, jitter: false },
  })), "linear");

  let functionAttempts = 0;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(await run.group(async (task) => task(async () => {
      functionAttempts++;
      if (functionAttempts < 2) throw new Error("function retry");
      return "function";
    }, {
      retry: { times: 2, backoff: () => 1, initialDelay: 1, maxDelay: 1, jitter: true },
    })), "function");
  } finally {
    Math.random = originalRandom;
  }

  await assert.rejects(
    run.group(async (task) => {
      await task(async (ctx) => {
        ctx.scope.cancel("already-aborted-retry-delay");
        throw new Error("delay sees aborted signal");
      }, {
        retry: { times: 2, initialDelay: 1, maxDelay: 1, jitter: false },
      });
    }),
    CancellationError
  );

  let noRetryAttempts = 0;
  await assert.rejects(
    run.group(async (task) => task(async () => {
      noRetryAttempts++;
      throw new Error("task option retryIf false");
    }, {
      retry: { times: 2, retryIf: () => false },
    })),
    /task option retryIf false/
  );
  assert.equal(noRetryAttempts, 1);

  let cancellationAttempts = 0;
  await assert.rejects(
    run.group(async (task) => task(async () => {
      cancellationAttempts++;
      throw new CancellationError({ kind: "manual", tag: "task-option-cancel" });
    }, { retry: 2 })),
    CancellationError
  );
  assert.equal(cancellationAttempts, 1);

  await assert.rejects(
    run.group(async (task) => {
      const handle = task(async () => {
        throw new Error("delay is cancelled while sleeping");
      }, {
        retry: { times: 2, initialDelay: 50, maxDelay: 50, jitter: false },
      });
      await sleep(5);
      handle.cancel("cancel-retry-delay");
      await handle;
    }),
    CancellationError
  );
});

test("retry delay listeners are removed after completed sleeps", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const retrying = run.retry(async () => {
    attempts++;
    if (attempts === 1) throw new Error("retry with delay");
    return "ok";
  }, { times: 2, initialDelay: 1, maxDelay: 1, jitter: false });

  assert.equal(await retrying({
    signal: controller.signal,
    id: "task-listener-check",
    name: "listener-check",
    kind: "io",
    attempt: 1,
    scope: {},
    context: {},
    report() {},
    log: { info() {}, warn() {}, error() {} },
    defer() {},
    consume() {},
  }), "ok");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  let taskSignal;
  let taskAttempts = 0;
  await run.group(async (task) => {
    await task(async (ctx) => {
      taskAttempts++;
      taskSignal = ctx.signal;
      if (taskAttempts === 1) throw new Error("task option retry");
      return "task-ok";
    }, { retry: { times: 2, initialDelay: 1, maxDelay: 1, jitter: false } }).catch(() => undefined);
  });
  assert.equal(getEventListeners(taskSignal, "abort").length, 0);
});

test("run.retry removes abort listeners when delay sleep is cancelled", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const retrying = run.retry(async () => {
    attempts++;
    throw new Error("wait for cancellation");
  }, { times: 2, initialDelay: 50, maxDelay: 50, jitter: false });

  setTimeout(() => controller.abort(new CancellationError({ kind: "manual", tag: "direct-retry-abort" })), 5);

  await assert.rejects(
    retrying({
      signal: controller.signal,
      id: "task-direct-retry-abort",
      name: "direct-retry-abort",
      kind: "io",
      attempt: 1,
      scope: {},
      context: {},
      report() {},
      log: { info() {}, warn() {}, error() {} },
      defer() {},
      consume() {},
    }),
    (err) => err instanceof CancellationError
      && err.reason.kind === "manual"
      && err.reason.tag === "direct-retry-abort"
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(attempts, 1);
});
