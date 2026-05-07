/**
 * High-coverage behavioral tests for engine internals exposed by the build.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  BudgetExceededError,
  CancellationError,
  ContextBagImpl,
  CostBudget,
  TelemetryBudget,
  createBudget,
  createContextKey,
  group,
  renderTree,
  run,
  work,
  TimeoutError,
  WorkAggregateError,
} from "../../dist/index.js";
import { EventBus } from "../../dist/engine/event-bus.js";
import { parseDuration } from "../../dist/engine/duration.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

const event = {
  type: "task:progress",
  taskId: "task-test",
  message: "test event",
  at: Date.now(),
};

test("duration parser accepts every supported unit and rejects invalid numbers", () => {
  assert.equal(parseDuration(12), 12);
  assert.equal(parseDuration("7ms"), 7);
  assert.equal(parseDuration("2s"), 2_000);
  assert.equal(parseDuration("3m"), 180_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.throws(() => parseDuration(Number.NaN), /Invalid duration/);
  assert.throws(() => parseDuration(2_147_483_648), /Invalid duration/);
  assert.throws(() => parseDuration("9999999999999999h"), /exceeds maximum timeout/);
});

test("context keys and budget keys cover optional metadata branches", () => {
  const Region = createContextKey("Region", "global");
  const CustomBudget = createBudget("CustomBudget");
  const context = new ContextBagImpl()
    .with(Region, "local")
    .with(CustomBudget, { spent: 0, limit: 1 });

  assert.equal(context.getOrThrow(Region), "local");
  assert.equal(CustomBudget.unit, undefined);
  assert.throws(() => createContextKey(""), /Context key name/);
  assert.throws(() => createContextKey("__proto__"), /reserved/);
  assert.throws(() => createBudget("BadBudget", { unit: "" }), /Budget unit/);
  assert.throws(
    () => new ContextBagImpl().with(CustomBudget, { spent: -1, limit: 1 }),
    /budget.spent/
  );
  assert.throws(
    () => new ContextBagImpl().with(CustomBudget, { spent: 2, limit: 1 }),
    /spent cannot exceed/
  );
  assert.equal(context.budgetIdentity(CustomBudget) !== undefined, true);
  assert.equal(context.budgetIdentity(Region), undefined);
});

test("event bus supports unsubscribe bubbling observer isolation and telemetry drops", () => {
  let unsubscribedCalls = 0;
  const parentEvents = [];
  const childEvents = [];
  const parent = new EventBus();
  const child = new EventBus(parent);

  const unsubscribe = child.on(() => {
    unsubscribedCalls++;
  });
  unsubscribe();
  child.emit(event);
  assert.equal(unsubscribedCalls, 0);

  parent.on(() => {
    throw new Error("observer failed");
  });
  parent.on((item) => parentEvents.push(item));
  child.on((item) => childEvents.push(item));
  child.emit(event);

  const context = new ContextBagImpl()
    .with(TelemetryBudget, { spent: 0, limit: 1, unit: "events" });

  child.emit(event, context);
  child.emit(event, context);
  child.emit(event, context);
  child.emit({ type: "scope:closed", scopeId: "scope-over-budget", durationMs: 1, at: Date.now() }, context);

  assert.equal(context.get(TelemetryBudget).spent, 1);
  assert.equal(child.droppedEventCount(), 2);
  assert.equal(childEvents.length, 4);
  assert.equal(parentEvents.length, 4);
  assert.equal(childEvents[2].data.telemetry_budget_exceeded, true);
  assert.equal(childEvents.filter((item) => item.data?.telemetry_budget_exceeded === true).length, 1);
  assert.equal(childEvents[3].type, "scope:closed");
  assert.equal(childEvents[3].droppedTelemetryEvents, 2);

  const fallbackContext = {
    get(key) {
      return key === TelemetryBudget ? { spent: 0, limit: 1, unit: "events" } : undefined;
    },
  };
  child.emit(event, fallbackContext);

  child.droppedCount = Number.MAX_SAFE_INTEGER;
  child.emit(event, context);
  assert.equal(child.droppedEventCount(), Number.MAX_SAFE_INTEGER);

  const capped = new EventBus();
  const unsubs = [];
  for (let index = 0; index < 10_000; index++) {
    unsubs.push(capped.on(() => {}));
  }
  assert.throws(() => capped.on(() => {}), /more than 10000 handlers/);
  for (const unsub of unsubs) unsub();
});

test("tree renderer covers status icons nesting depth unicode and aggregate counts", () => {
  const snapshot = {
    id: "scope-root",
    name: "root",
    status: "running",
    startedAt: 0,
    pendingCount: 1,
    completedCount: 1,
    failedCount: 1,
    cancelledCount: 1,
    tasks: [
      { id: "task-ok", name: "ok", kind: "io", status: "succeeded", attempt: 1, startedAt: 0, durationMs: 4 },
      { id: "task-failed", name: "failed", kind: "io", status: "failed", attempt: 1, startedAt: 0 },
      { id: "task-cancelled", name: "cancelled", kind: "io", status: "cancelled", attempt: 1, startedAt: 0 },
      { id: "task-running", name: "running", kind: "io", status: "running", attempt: 1, startedAt: 0, progress: { pct: 0.42 } },
      { id: "task-pending", name: "pending", kind: "io", status: "pending", attempt: 1, startedAt: 0 },
    ],
    scopes: [{
      id: "scope-child",
      name: "child",
      status: "closed",
      startedAt: 0,
      pendingCount: 0,
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      tasks: [{ id: "task-child", name: "child-task", kind: "io", status: "succeeded", attempt: 1, startedAt: 0 }],
      scopes: [],
    }],
  };

  const ascii = renderTree(snapshot, { ascii: true });
  assert.match(ascii, /\[X\] failed/);
  assert.match(ascii, /\[!\] cancelled/);
  assert.match(ascii, /\[\.\.\] running/);
  assert.match(ascii, /\[ \] pending/);
  assert.match(ascii, /6 tasks/);

  const unicode = renderTree(snapshot, { ascii: false, showDurations: false, showProgress: false });
  assert.match(unicode, /root/);
  assert.match(unicode, /tasks/);

  const shallow = renderTree(snapshot, { ascii: true, maxDepth: 0 });
  assert.doesNotMatch(shallow, /task-ok/);

  const previousNoUnicode = process.env.NO_UNICODE;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  process.env.NO_UNICODE = "1";
  try {
    const fallbackNames = renderTree({
      id: "scope-without-name",
      status: "running",
      startedAt: 0,
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      tasks: [],
      scopes: [{
        id: "child-without-name",
        status: "closed",
        startedAt: 0,
        pendingCount: 0,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        tasks: [],
        scopes: [],
      }],
    });
    assert.match(fallbackNames, /scope-without-name/);
    assert.match(fallbackNames, /child-without-name/);
  } finally {
    if (previousNoUnicode === undefined) delete process.env.NO_UNICODE;
    else process.env.NO_UNICODE = previousNoUnicode;
  }

  process.env.NO_UNICODE = "0";
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  try {
    assert.match(renderTree(snapshot), /tasks/);
  } finally {
    if (previousNoUnicode === undefined) delete process.env.NO_UNICODE;
    else process.env.NO_UNICODE = previousNoUnicode;

    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      delete process.stdout.isTTY;
    }
  }
});

test("scope exposes closed spawn guard cancellation cleanup and status branches", async () => {
  const events = [];
  const reasons = [];
  let capturedScope;

  await group(async (task) => {
    await task(async (ctx) => {
      capturedScope = ctx.scope;
      ctx.scope.onEvent((item) => events.push(item));
      const unsubscribe = ctx.scope.onCancel(() => reasons.push("removed"));
      unsubscribe();
      ctx.scope.onCancel(() => {
        throw new Error("cancel observer failed");
      });
      ctx.scope.onCancel((reason) => reasons.push(reason.kind));
      ctx.scope.defer(() => {
        throw new Error("scope cleanup failed");
      });
      ctx.defer(() => {
        throw new Error("task cleanup failed");
      });
      ctx.scope.cancel("manual-cancel");
    });
  });

  assert.deepEqual(reasons, ["manual"]);
  assert.ok(events.some((item) => item.type === "task:failed"));
  assert.throws(() => capturedScope.spawn(async () => "late"), /closed scope/);
});

test("successful scopes emit closing and closed transition events", async () => {
  const events = [];

  const result = await group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((item) => events.push(item));
      return "ok";
    });
    return "done";
  });

  assert.equal(result, "done");
  assert.ok(events.some((item) => item.type === "scope:closing" && item.reason === "completed"));
  assert.ok(events.some((item) => item.type === "scope:closed"));
});

test("scope boundary strings and defer caps are enforced", async () => {
  await assert.rejects(
    group(async (task) => {
      await task(async () => "bad", { name: "" });
    }),
    /task name/
  );

  await assert.rejects(
    group(async (task) => {
      await task(async () => "bad", { idempotencyKey: "x".repeat(513) });
    }),
    /idempotency key/
  );

  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        ctx.scope.cancel("");
      });
    }),
    /manual cancel tag/
  );

  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        for (let index = 0; index < 10_000; index++) ctx.defer(() => {});
        ctx.defer(() => {});
      });
    }),
    /cleanup callbacks/
  );

  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        for (let index = 0; index < 10_000; index++) ctx.scope.defer(() => {});
        ctx.scope.defer(() => {});
      });
    }),
    /cleanup callbacks/
  );
});

test("scope closing events classify every cancellation reason", async () => {
  const cases = [
    [{ kind: "parent_failed", error: new Error("parent") }, "errored"],
    [{ kind: "sibling_failed", siblingId: "task-sibling", error: new Error("sibling") }, "errored"],
    [{ kind: "budget", budgetKey: "CostBudget", limit: 1, spent: 2 }, "errored"],
    [{ kind: "user", message: "stop" }, "cancelled"],
    [{ kind: "deadline", deadlineAt: Date.now(), elapsedMs: 1 }, "cancelled"],
    [{ kind: "timeout", timeoutMs: 1 }, "cancelled"],
    [{ kind: "race_lost", winnerId: "task-winner" }, "cancelled"],
    [{ kind: "scope_ended" }, "cancelled"],
    [{ kind: "manual", tag: "manual" }, "cancelled"],
  ];

  for (const [reason, expected] of cases) {
    const events = [];

    await group(async (task) => {
      await task(async (ctx) => {
        ctx.scope.onEvent((item) => events.push(item));
        ctx.scope.cancel(reason);
        return "ok";
      });
    });

    assert.ok(
      events.some((item) => item.type === "scope:closing" && item.reason === expected),
      `expected ${reason.kind} to close as ${expected}`
    );
  }
});

test("task handle getters report fields log levels and custom budget consumption work", async () => {
  const CustomBudget = createBudget("CustomBudget", { unit: "credits" });
  const events = [];
  const budget = { spent: 0, limit: 5 };
  const context = new ContextBagImpl().with(CustomBudget, budget);

  await group(async (task) => {
    const handle = task(async (ctx) => {
      ctx.scope.onEvent((item) => events.push(item));
      assert.equal(ctx.name, "instrumented");
      ctx.report({ message: "halfway", data: { step: 1 } });
      ctx.log.debug("debugged");
      ctx.log.warn("warned");
      ctx.log.error("errored");
      ctx.consume(CustomBudget, 2);
      return "ok";
    }, { name: "instrumented", kind: "custom" });

    assert.equal(typeof handle.status, "string");
    assert.equal(await handle, "ok");
    assert.equal(handle.status, "succeeded");
  }, {
    context,
  });

  assert.equal(context.get(CustomBudget).spent, 2);
  assert.ok(events.some((item) => item.message === "halfway" && item.data.step === 1));
  assert.ok(events.some((item) => item.data?.logLevel === "debug"));
  assert.ok(events.some((item) => item.data?.logLevel === "warn"));
  assert.ok(events.some((item) => item.data?.logLevel === "error"));
});

test("scope deadline and status snapshots include failed cancelled metadata and child scopes", async () => {
  await assert.rejects(
    group(async (task) => task(async (ctx) => {
      await sleep(50, ctx.signal);
    }), { deadline: 1 }),
    CancellationError
  );

  let snapshot;
  await assert.rejects(
    run.scope(async (scope) => {
      const cancelled = scope.spawn(async () => {
        throw new CancellationError({ kind: "manual", tag: "snapshot-cancel" });
      }, { name: "cancelled-task" });
      await cancelled.catch(() => undefined);

      const failed = scope.spawn(async () => {
        throw new Error("snapshot-fail");
      }, { name: "failed-task", meta: { source: "test" } });
      await failed.catch(() => undefined);

      snapshot = scope.status();
    }, { name: "snapshot-scope", deadline: 1_000 }),
    /snapshot-fail/
  );

  assert.equal(snapshot.cancelledCount, 1);
  assert.equal(snapshot.failedCount, 1);
  assert.equal(snapshot.tasks.find((item) => item.name === "failed-task").meta.source, "test");
  assert.equal(typeof snapshot.deadlineAt, "number");

  let parentSnapshot;
  await group(async (task) => {
    await task(async (ctx) => {
      const child = group(async (childTask) => {
        childTask.background(async (childCtx) => sleep(20, childCtx.signal));
        await sleep(5);
      }, { name: "child-scope" });
      await sleep(1);
      parentSnapshot = ctx.scope.status();
      await child;
    });
  }, { name: "parent-scope" });

  assert.ok(parentSnapshot.scopes.some((item) => item.name === "child-scope"));

  let childCompleted = false;
  await group(async (task) => {
    await task(async () => {
      void group(async (childTask) => {
        childTask.background(async (childCtx) => {
          await sleep(20, childCtx.signal);
          childCompleted = true;
        });
      }, { name: "close-owned-child" });
    });
  }, { name: "close-parent" });

  assert.equal(childCompleted, true);
});

test("background task failures are observed without becoming sibling failures", async () => {
  const events = [];

  const result = await group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((item) => events.push(item));
      task.background(async () => {
        throw new Error("background failed");
      });
    });
    return "body-ok";
  });

  assert.equal(result, "body-ok");
  assert.ok(events.some((item) => item.type === "task:failed"));
});

test("budget inspection filters non-budgets and custom context falls back to leaf owner", async () => {
  const Label = createContextKey("Label");
  const context = new ContextBagImpl()
    .with(Label, "not a budget")
    .with(CostBudget, { spent: 0, limit: 10, unit: "USD" });

  const budgets = await group(
    async (task) => task(async (ctx) => ctx.budgets()),
    { context }
  );
  assert.deepEqual(budgets.map((item) => item.key), ["CostBudget"]);

  const budget = { spent: 1, limit: 1, unit: "USD" };
  const customContext = {
    get(key) {
      return key.name === CostBudget.name ? budget : undefined;
    },
    getOrThrow(key) {
      const value = this.get(key);
      if (value === undefined) throw new Error(`missing ${key.name}`);
      return value;
    },
    with() {
      return this;
    },
    has() {
      return false;
    },
  };

  await assert.rejects(
    group(async (task) => task(async (ctx) => {
      assert.deepEqual(ctx.budgets(), []);
      ctx.consumeCost(1);
    }), { context: customContext }),
    BudgetExceededError
  );

  const UnitBudget = createBudget("UnitBudget", { unit: "credits" });
  await assert.rejects(
    group(async (task) => task(async (ctx) => {
      ctx.consume(UnitBudget, 2);
    }), {
      context: new ContextBagImpl().with(UnitBudget, { spent: 0, limit: 1 }),
    }),
    (err) => err instanceof BudgetExceededError && err.unit === "credits"
  );

  const PlainBudget = createBudget("PlainBudget");
  await assert.rejects(
    group(async (task) => task(async (ctx) => {
      ctx.consume(PlainBudget, 2);
    }), {
      context: new ContextBagImpl().with(PlainBudget, { spent: 0, limit: 1 }),
    }),
    (err) => err instanceof BudgetExceededError && err.unit === undefined
  );
});

test("run helpers cover race failure any cancellation retry policies and breaker branches", async () => {
  assert.equal(await run.race([async () => "first", async () => "second"]), "first");

  await assert.rejects(
    run.race([
      async () => {
        throw new Error("race failed first");
      },
      async (ctx) => {
        await sleep(100, ctx.signal);
        return "late";
      },
    ]),
    /race failed first/
  );

  assert.equal(await run.any([
    async () => {
      throw new CancellationError({ kind: "manual", tag: "skip" });
    },
    async () => "winner",
  ]), "winner");

  assert.equal(await group(async (task) => task(run.deadline(async () => "date-deadline", new Date(Date.now() + 1_000)))), "date-deadline");

  assert.deepEqual(await run.series([async () => 1, async () => 2]), [1, 2]);

  let retryAttempts = 0;
  await assert.rejects(
    group(async (task) => task(run.retry(async () => {
      retryAttempts++;
      throw new Error("do not retry");
    }, { times: 3, retryIf: () => false }))),
    /do not retry/
  );
  assert.equal(retryAttempts, 1);

  const abortedDelay = new AbortController();
  const abortReason = new CancellationError({ kind: "manual", tag: "retry-delay-abort" });
  abortedDelay.abort(abortReason);
  await assert.rejects(
    run.retry(async () => {
      throw new Error("retry delay should see aborted signal");
    }, { times: 2, initialDelay: 1, maxDelay: 1, jitter: false })({
      signal: abortedDelay.signal,
      id: "task-retry-abort",
      name: "retry-abort",
      kind: "io",
      attempt: 1,
      scope: {},
      context: new ContextBagImpl(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      defer() {},
      report() {},
      consumeCost() {},
      consume() {},
      budgets() { return []; },
    }),
    CancellationError
  );

  let linearAttempts = 0;
  assert.equal(await group(async (task) => task(run.retry(async () => {
    linearAttempts++;
    if (linearAttempts < 2) throw new Error("linear");
    return "linear-ok";
  }, { times: 2, backoff: "linear", initialDelay: 1, maxDelay: 1, jitter: false }))), "linear-ok");

  let jitterAttempts = 0;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(await group(async (task) => task(run.retry(async () => {
      jitterAttempts++;
      if (jitterAttempts < 2) throw new Error("jitter");
      return "jitter-ok";
    }, { times: 2, backoff: "fixed", initialDelay: 1, maxDelay: 1, jitter: true }))), "jitter-ok");
  } finally {
    Math.random = originalRandom;
  }

  const preAborted = new AbortController();
  preAborted.abort(new CancellationError({ kind: "manual", tag: "already-aborted" }));
  await assert.rejects(
    run.hedge(async () => "never", { after: 1, max: 2 })({
      signal: preAborted.signal,
      id: "task-pre-aborted",
      name: "pre-aborted",
      kind: "io",
      attempt: 1,
      scope: {},
      context: new ContextBagImpl(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      defer() {},
      report() {},
      consumeCost() {},
      consume() {},
      budgets() { return []; },
    }),
    CancellationError
  );

  const cancelledBreaker = run.circuitBreaker(async () => {
    throw new CancellationError({ kind: "manual", tag: "breaker-cancel" });
  }, { failureThreshold: 1, resetAfter: 10 });
  await assert.rejects(group(async (task) => task(cancelledBreaker)), CancellationError);

  let breakerCalls = 0;
  const breaker = run.circuitBreaker(async (ctx) => {
    breakerCalls++;
    if (breakerCalls === 1) throw new Error("open breaker");
    await sleep(30, ctx.signal);
    return "closed";
  }, { failureThreshold: 1, resetAfter: 1, halfOpenMaxCalls: 1 });

  await assert.rejects(group(async (task) => task(breaker)), /open breaker/);
  await sleep(5);
  const first = group(async (task) => task(breaker));
  const second = group(async (task) => task(breaker));
  await assert.rejects(second, /half-open/);
  assert.equal(await first, "closed");
});

test("supervise policies cover restart filters window expiry and scoped spawn", async () => {
  await assert.rejects(run.supervise(async () => {
    throw new CancellationError({ kind: "manual", tag: "supervise-cancel" });
  }), CancellationError);

  let neverRestarted = 0;
  await assert.rejects(run.supervise(async () => {
    neverRestarted++;
    throw new Error("no restart");
  }, { restartOn: () => false }), /no restart/);
  assert.equal(neverRestarted, 1);

  let windowAttempts = 0;
  await assert.rejects(run.supervise(async () => {
    windowAttempts++;
    await sleep(2);
    throw new Error("expired window");
  }, { resetWindow: 0, maxRestarts: 3 }), /expired window/);
  assert.equal(windowAttempts, 1);

  let scopedResult;
  await group(async () => {
    scopedResult = await run.supervise(async () => "scoped", { restartOn: "always" });
  });
  assert.equal(scopedResult, "scoped");
});

test("work builder covers async sources aliases timeout deadline cancellation and validation", async () => {
  async function* source() {
    yield 1;
    yield 2;
  }

  assert.deepEqual(
    (await work(source()).inSeries().withConcurrencyLimit(1).do(async (item) => item * 2)).results,
    [2, 4]
  );

  assert.throws(() => work([1]).inParallel(0), /positive integer/);

  await assert.rejects(
    work([1]).withTimeout(1).do(async (_item, ctx) => {
      await sleep(50, ctx.signal);
      return "late";
    }),
    CancellationError
  );

  await assert.rejects(
    work([1]).withDeadline(Date.now() + 1).do(async (_item, ctx) => {
      await sleep(50, ctx.signal);
      return "late";
    }),
    CancellationError
  );

  assert.deepEqual(
    await work([1]).withDeadline(new Date(Date.now() + 1_000)).collect(),
    [1]
  );

  const collected = await work([1, 2])
    .filter((item) => item === 1)
    .onError("collect")
    .do(async (item) => item);
  assert.deepEqual(collected.results.map((item) => item.status), ["fulfilled", "cancelled"]);

  const continued = await work([1])
    .onError("continue")
    .do(async () => {
      throw new CancellationError({ kind: "manual", tag: "work-cancel" });
    });
  assert.equal(continued.errors.length, 0);
  assert.equal(continued.results.length, 0);
});

test("error constructors expose optional metadata branches", () => {
  const withoutUnit = new BudgetExceededError({
    budgetKey: "NoUnitBudget",
    limit: 1,
    spent: 1,
    attempted: 1,
  });

  assert.equal(withoutUnit.unit, undefined);
  assert.equal(withoutUnit.name, "BudgetExceededError");

  const cancelRealmLike = { [Symbol.for("workjs.error.CancellationError")]: true };
  const timeout = new TimeoutError(10);
  const aggregate = new WorkAggregateError([new Error("x")]);

  assert.equal(cancelRealmLike instanceof CancellationError, true);
  assert.equal(timeout instanceof CancellationError, true);
  assert.equal(timeout instanceof TimeoutError, true);
  assert.equal(withoutUnit instanceof BudgetExceededError, true);
  assert.equal(aggregate instanceof WorkAggregateError, true);
});
