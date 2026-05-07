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

test("run.retry rejects unsafe retry attempt counts at the policy boundary", async () => {
  assert.throws(
    () => run.retry(async () => "never", { times: 1_000_000 }),
    /retry attempts/
  );

  await assert.rejects(
    run.group(async (task) => {
      await task(async () => "never", { retry: { times: 1_000_000 } });
    }),
    /must use run.retry/
  );
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

test("run.bracket releases acquired resources exactly once on success and failure", async () => {
  const released = [];

  const successful = run.bracket(
    async () => "success-resource",
    async (resource) => `used:${resource}`,
    async (resource) => {
      released.push(resource);
    }
  );

  assert.equal(await run.group(async (task) => task(successful)), "used:success-resource");
  assert.deepEqual(released, ["success-resource"]);

  const failing = run.bracket(
    async () => "failing-resource",
    async () => {
      throw new Error("use failed");
    },
    async (resource) => {
      released.push(resource);
    }
  );

  await assert.rejects(run.group(async (task) => task(failing)), /use failed/);
  assert.deepEqual(released, ["success-resource", "failing-resource"]);

  const acquireFailed = run.bracket(
    async () => {
      throw new Error("acquire failed");
    },
    async () => "never",
    async () => {
      released.push("must-not-release");
    }
  );

  await assert.rejects(run.group(async (task) => task(acquireFailed)), /acquire failed/);
  assert.deepEqual(released, ["success-resource", "failing-resource"]);
});

test("run.bracket releases on cancellation using bounded cleanup semantics", async () => {
  const events = [];
  const released = [];

  await assert.rejects(
    run.group(async (task) => {
      await task(async (ctx) => {
        ctx.scope.onEvent((event) => events.push(event));
      });
      await task(run.timeout(run.bracket(
        async () => "cancelled-resource",
        async (_resource, ctx) => {
          await sleep(1_000, ctx.signal);
          return "late";
        },
        async (resource) => {
          released.push(resource);
        }
      ), 5));
    }),
    TimeoutError
  );

  assert.deepEqual(released, ["cancelled-resource"]);
  assert.ok(!events.some((event) => event.type === "task:cleanup_failed"));
});

test("run.bracket emits cleanup timeout when release does not settle", async () => {
  const events = [];

  await run.group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((event) => events.push(event));
    });
    assert.equal(await task(run.bracket(
      async () => "resource",
      async () => "value",
      async () => {
        await new Promise(() => {});
      },
      { timeout: 5 }
    )), "value");
  });

  assert.ok(events.some((event) => event.type === "task:cleanup_timeout" && event.timeoutMs === 5));
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

test("run.circuitBreaker resets closed-state failures after success", async () => {
  let calls = 0;
  const wrapped = run.circuitBreaker(async () => {
    calls++;
    if (calls === 1 || calls === 3) throw new Error(`transient ${calls}`);
    return `ok-${calls}`;
  }, { failureThreshold: 2, resetAfter: 20 });

  await assert.rejects(run.group(async (task) => task(wrapped)), /transient 1/);
  assert.equal(await run.group(async (task) => task(wrapped)), "ok-2");
  await assert.rejects(run.group(async (task) => task(wrapped)), /transient 3/);
  assert.equal(await run.group(async (task) => task(wrapped)), "ok-4");
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

test("run.circuitBreaker reopens when any admitted half-open probe fails", async () => {
  let calls = 0;
  const wrapped = run.circuitBreaker(async (ctx) => {
    calls++;
    if (calls <= 3) throw new Error(`opening failure ${calls}`);
    if (calls === 4) {
      await sleep(1, ctx.signal);
      return "half-open-success";
    }
    if (calls === 5) {
      await sleep(20, ctx.signal);
      throw new Error("half-open-failure");
    }
    return "must-not-pass";
  }, { failureThreshold: 3, resetAfter: 50, halfOpenMaxCalls: 2 });

  await assert.rejects(run.group(async (task) => task(wrapped)), /opening failure 1/);
  await assert.rejects(run.group(async (task) => task(wrapped)), /opening failure 2/);
  await assert.rejects(run.group(async (task) => task(wrapped)), /opening failure 3/);
  await sleep(60);

  const probes = await run.allSettled([wrapped, wrapped]);
  assert.deepEqual(probes.map((item) => item.status), ["fulfilled", "rejected"]);
  await assert.rejects(run.group(async (task) => task(wrapped)), /Circuit breaker is open/);
});

test("run.circuitBreaker ignores stale half-open success after a probe failure", async () => {
  let calls = 0;
  const wrapped = run.circuitBreaker(async (ctx) => {
    calls++;
    if (calls <= 3) throw new Error(`opening failure ${calls}`);
    if (calls === 4) {
      await sleep(1, ctx.signal);
      throw new Error("half-open-failure");
    }
    if (calls === 5) {
      await sleep(20, ctx.signal);
      return "stale-success";
    }
    return "must-not-pass";
  }, { failureThreshold: 3, resetAfter: 50, halfOpenMaxCalls: 2 });

  await assert.rejects(run.group(async (task) => task(wrapped)), /opening failure 1/);
  await assert.rejects(run.group(async (task) => task(wrapped)), /opening failure 2/);
  await assert.rejects(run.group(async (task) => task(wrapped)), /opening failure 3/);
  await sleep(60);

  const probes = await run.allSettled([wrapped, wrapped]);
  assert.deepEqual(probes.map((item) => item.status), ["rejected", "fulfilled"]);
  await assert.rejects(run.group(async (task) => task(wrapped)), /Circuit breaker is open/);
});

test("run.circuitBreaker ignores stale closed-call success after another call opens it", async () => {
  let calls = 0;
  const wrapped = run.circuitBreaker(async (ctx) => {
    calls++;
    if (calls === 1) {
      await sleep(30, ctx.signal);
      return "late-success";
    }
    throw new Error("fast-failure");
  }, { failureThreshold: 1, resetAfter: 50 });

  const settled = await run.allSettled([wrapped, wrapped]);
  assert.deepEqual(settled.map((item) => item.status), ["fulfilled", "rejected"]);
  await assert.rejects(run.group(async (task) => task(wrapped)), /Circuit breaker is open/);
});

test("run.circuitBreaker ignores stale closed-call failure after another call opens it", async () => {
  let calls = 0;
  const wrapped = run.circuitBreaker(async (ctx) => {
    calls++;
    if (calls === 1) await sleep(30, ctx.signal);
    throw new Error(`failure-${calls}`);
  }, { failureThreshold: 1, resetAfter: 50 });

  const settled = await run.allSettled([wrapped, wrapped]);
  assert.deepEqual(settled.map((item) => item.status), ["rejected", "rejected"]);
  await assert.rejects(run.group(async (task) => task(wrapped)), /Circuit breaker is open/);
});

test("run.circuitBreaker ignores stale half-open failure after a newer recovery epoch", async () => {
  let calls = 0;
  const wrapped = run.circuitBreaker(async (ctx) => {
    calls++;
    if (calls === 1) throw new Error("opening failure");
    if (calls === 2) throw new Error("fast half-open failure");
    if (calls === 3) {
      await sleep(40, ctx.signal);
      throw new Error("stale half-open failure");
    }
    return `fresh-success-${calls}`;
  }, { failureThreshold: 1, resetAfter: 5, halfOpenMaxCalls: 2 });

  await assert.rejects(run.group(async (task) => task(wrapped)), /opening failure/);
  await sleep(10);

  const fastFailure = run.group(async (task) => task(wrapped));
  const staleFailure = run.group(async (task) => task(wrapped));
  await assert.rejects(fastFailure, /fast half-open failure/);

  await sleep(10);
  assert.equal(await run.group(async (task) => task(wrapped)), "fresh-success-4");
  await assert.rejects(staleFailure, /stale half-open failure/);
  assert.equal(await run.group(async (task) => task(wrapped)), "fresh-success-5");
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

test("run.detached can be bounded by maxLifetime for non-cooperative work", async () => {
  const handle = run.detached(async () => {
    await new Promise(() => {});
  }, { maxLifetime: 10 });

  await assert.rejects(handle, TimeoutError);
  assert.equal(handle.status, "failed");

  const unbounded = run.detached(async () => "unbounded-ok", {
    name: "unbounded-detached",
    maxLifetime: false,
    cleanupTimeout: 5,
  });
  assert.equal(await unbounded, "unbounded-ok");
  assert.equal(unbounded.name, "unbounded-detached");
});

test("background timeout is a failed background task, not scope cancellation", async () => {
  const events = [];

  const result = await run.group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((event) => events.push(event));
    });
    run.background(run.timeout(async (ctx) => {
      await sleep(1_000, ctx.signal);
      return "late";
    }, 5));
    return "scope-result";
  });

  assert.equal(result, "scope-result");
  assert.ok(events.some((event) => event.type === "task:failed" && event.error instanceof TimeoutError));
  assert.ok(!events.some((event) => event.type === "scope:closing" && event.reason === "cancelled"));
});

test("run.context.budget returns undefined when no budget is installed", () => {
  assert.equal(run.context.budget({ name: "MissingBudget" }), undefined);
});

test("run.context.budget preserves optional unit shape", async () => {
  const UnitlessBudget = createContextKey("UnitlessBudget");
  let snapshot;

  await run.context.with(UnitlessBudget, { spent: 0, limit: 2 }, async () => {
    await run.group(async (task) => {
      await task(async (ctx) => {
        ctx.consume(UnitlessBudget, 1);
      });
    });
    snapshot = run.context.budget(UnitlessBudget);
  });

  assert.deepEqual(snapshot, { spent: 1, limit: 2 });
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

test("task options support idempotency and reject runtime policy shortcuts", async () => {
  let idempotentExecutions = 0;

  const result = await run.group(async (task) => {
    const first = task(async () => {
      idempotentExecutions++;
      return "same-result";
    }, { name: "same-a", idempotencyKey: "upload:1" });

    const second = task(async () => {
      idempotentExecutions++;
      return "wrong-result";
    }, { name: "same-b", idempotencyKey: "upload:1" });

    return [await first, await second];
  });

  assert.deepEqual(result, ["same-result", "same-result"]);
  assert.equal(idempotentExecutions, 1);

  const afterSettlement = await taskAfterIdempotencySettlement();
  assert.deepEqual(afterSettlement, ["after-first", "after-second"]);

  await assert.rejects(
    run.group(async (task) => task(async () => "bad", { retry: 2 })),
    /must use run.retry/
  );

  await assert.rejects(
    run.group(async (task) => task(async () => "bad", { timeout: 1 })),
    /must use run.retry/
  );

  await assert.rejects(
    run.group(async (task) => task(async () => "bad", { deadline: Date.now() + 1 })),
    /must use run.retry/
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

test("run.retry policies cover cancel-aware delay and backoff branches", async () => {
  let fixedAttempts = 0;
  assert.equal(await run.group(async (task) => task(run.retry(async () => {
    fixedAttempts++;
    if (fixedAttempts < 2) throw new Error("fixed retry");
    return "fixed";
  }, { times: 2, backoff: "fixed", initialDelay: 1, maxDelay: 1, jitter: false }))), "fixed");

  let numericAttempts = 0;
  assert.equal(await run.group(async (task) => task(run.retry(async () => {
    numericAttempts++;
    if (numericAttempts < 2) throw new Error("numeric retry");
    return "numeric";
  }, 2))), "numeric");

  let linearAttempts = 0;
  assert.equal(await run.group(async (task) => task(run.retry(async () => {
    linearAttempts++;
    if (linearAttempts < 2) throw new Error("linear retry");
    return "linear";
  }, { times: 2, backoff: "linear", initialDelay: 1, maxDelay: 1, jitter: false }))), "linear");

  let functionAttempts = 0;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(await run.group(async (task) => task(run.retry(async () => {
      functionAttempts++;
      if (functionAttempts < 2) throw new Error("function retry");
      return "function";
    }, { times: 2, backoff: () => 1, initialDelay: 1, maxDelay: 1, jitter: true }))), "function");
  } finally {
    Math.random = originalRandom;
  }

  await assert.rejects(
    run.group(async (task) => {
      await task(run.retry(async (ctx) => {
        ctx.scope.cancel("already-aborted-retry-delay");
        throw new Error("delay sees aborted signal");
      }, { times: 2, initialDelay: 1, maxDelay: 1, jitter: false }));
    }),
    CancellationError
  );

  let noRetryAttempts = 0;
  await assert.rejects(
    run.group(async (task) => task(run.retry(async () => {
      noRetryAttempts++;
      throw new Error("run retryIf false");
    }, { times: 2, retryIf: () => false }))),
    /run retryIf false/
  );
  assert.equal(noRetryAttempts, 1);

  let cancellationAttempts = 0;
  await assert.rejects(
    run.group(async (task) => task(run.retry(async () => {
      cancellationAttempts++;
      throw new CancellationError({ kind: "manual", tag: "task-option-cancel" });
    }, 2))),
    CancellationError
  );
  assert.equal(cancellationAttempts, 1);

  await assert.rejects(
    run.group(async (task) => {
      const handle = task(run.retry(async () => {
        throw new Error("delay is cancelled while sleeping");
      }, { times: 2, initialDelay: 50, maxDelay: 50, jitter: false }));
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
    await task(run.retry(async (ctx) => {
      taskAttempts++;
      taskSignal = ctx.signal;
      if (taskAttempts === 1) throw new Error("scoped retry");
      return "task-ok";
    }, { times: 2, initialDelay: 1, maxDelay: 1, jitter: false })).catch(() => undefined);
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
