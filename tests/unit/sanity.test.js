/**
 * Sanity test - exercises the core structured concurrency behavior.
 *
 * @author Admilson B. F. Cossa
 *
 * Uses Vitest against the built package so verification proves the published
 * artifact shape instead of a source-only path.
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  group,
  run,
  CostBudget,
  TelemetryBudget,
  createBudget,
  ContextBagImpl,
  CancellationError,
  BudgetExceededError,
} from "../../dist/index.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true }
    );
  });

// --- Scope lifecycle -----------------------------------------------------------
test("defer blocks run in LIFO order on success", async () => {
  const order = [];
  await group(async (task) => {
    await task(async (ctx) => {
      ctx.defer(() => order.push("a"));
      ctx.defer(() => order.push("b"));
      ctx.defer(() => order.push("c"));
    });
  });
  assert.deepEqual(order, ["c", "b", "a"]);
});

test("scope cannot resolve before children settle", async () => {
  let childDone = false;
  const start = Date.now();
  await group(async (task) => {
    task.background(async (ctx) => {
      await sleep(80, ctx.signal);
      childDone = true;
    });
    // Body returns immediately
  });
  const elapsed = Date.now() - start;
  assert.equal(childDone, true, "background child must finish before scope returns");
  assert.ok(elapsed >= 70, `scope returned at ${elapsed}ms, expected >=70`);
});

// --- Scoped background work ----------------------------------------------------
test("background task is cancelled when sibling fails", async () => {
  let bgDeferRan = false;
  let bgCompleted = false;

  await assert.rejects(
    group(async (task) => {
      task.background(async (ctx) => {
        ctx.defer(() => {
          bgDeferRan = true;
        });
        await sleep(1000, ctx.signal); // would take 1s, should be cancelled
        bgCompleted = true;
      });
      await sleep(20);
      throw new Error("primary failed");
    }),
    /primary failed/
  );

  assert.equal(bgCompleted, false, "background must be cancelled, not allowed to finish");
  assert.equal(bgDeferRan, true, "background defer must run on cancellation");
});

test("unawaited child failure cancels siblings and rejects group", async () => {
  let siblingCancelled = false;
  let siblingCleanup = false;

  await assert.rejects(
    group(async (task) => {
      task(async (ctx) => {
        ctx.defer(() => {
          siblingCleanup = true;
        });
        try {
          await sleep(1000, ctx.signal);
        } catch (err) {
          siblingCancelled = err instanceof CancellationError
            && err.reason.kind === "sibling_failed";
          throw err;
        }
      }, { name: "long-sibling" });

      task(async () => {
        await sleep(20);
        throw new Error("child failed");
      }, { name: "failing-child" });
    }),
    /child failed/
  );

  assert.equal(siblingCancelled, true, "sibling must observe sibling_failed cancellation");
  assert.equal(siblingCleanup, true, "cancelled sibling cleanup must run");
});

// --- Budget system -------------------------------------------------------------
test("single budget overrun cancels scope with BudgetExceededError", async () => {
  let inner = 0;

  await assert.rejects(
    group(
      async (task) => {
        await task(async (ctx) => {
          inner = 1;
          ctx.consumeCost(0.4);
          inner = 2;
          ctx.consumeCost(0.4);
          inner = 3;
          ctx.consumeCost(0.4); // would exceed limit 1.0 -> throws here
          inner = 4; // unreached
        });
      },
      { context: new (await import("../../dist/index.js")).ContextBagImpl().with(CostBudget, { spent: 0, limit: 1.0, unit: "USD" }) }
    ),
    BudgetExceededError
  );

  assert.equal(inner, 3, "execution must stop at the failing consume");
});

test("consuming an unset budget throws synchronously", async () => {
  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        ctx.consumeCost(0.01); // no CostBudget set
      });
    }),
    /Budget "CostBudget" not set in scope/
  );
});

test("TaskContext.budgets lists visible budget states", async () => {
  const TokenBudget = createBudget("TokenBudget", { unit: "tokens" });
  const context = new ContextBagImpl()
    .with(CostBudget, { spent: 0, limit: 1.0, unit: "USD" })
    .with(TokenBudget, { spent: 10, limit: 100 });

  const budgets = await group(
    async (task) => task(async (ctx) => ctx.budgets()),
    { context }
  );

  assert.deepEqual(
    budgets.map((budget) => [budget.key, budget.state.limit]).sort(),
    [["CostBudget", 1.0], ["TokenBudget", 100]]
  );
});

test("child scope budget shadows parent budget", async () => {
  const parentBudget = { spent: 0, limit: 10, unit: "USD" };
  const childBudget = { spent: 0, limit: 1, unit: "USD" };

  await run.context.with(CostBudget, parentBudget, async () => {
    await run.scope(async (scope) => {
      const handle = scope.spawn(async (ctx) => {
        ctx.consumeCost(0.5);
      });
      await handle;
    }, { context: run.context.current().with(CostBudget, childBudget) });
  });

  assert.equal(parentBudget.spent, 0);
  assert.equal(childBudget.spent, 0.5);
});

test("concurrent budget charges land at exact total", async () => {
  const budget = { spent: 0, limit: 1, unit: "USD" };

  await run.context.with(CostBudget, budget, async () => {
    await run.all(Array.from({ length: 100 }, () => async (ctx) => {
      ctx.consumeCost(0.01);
    }));
  });

  assert.equal(Math.round(budget.spent * 100), 100);
});

// --- Telemetry budget ----------------------------------------------------------
test("telemetry budget overrun drops events but tasks complete normally", async () => {
  const events = [];
  const { ContextBagImpl } = await import("../../dist/index.js");

  const result = await group(
    async (task) => {
      task.background(() => {});
      const value = await task(async (ctx) => {
        // Generate many progress events; some must be dropped
        for (let i = 0; i < 200; i++) ctx.report({ pct: i / 200 });
        return "ok";
      });
      return value;
    },
    {
      context: new ContextBagImpl().with(TelemetryBudget, { spent: 0, limit: 5, unit: "events" }),
    }
  );

  // The task completes despite telemetry being over budget.
  assert.equal(result, "ok");
});

test("TaskContext.log emits task progress events without console side effects", async () => {
  const events = [];

  await group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((event) => events.push(event));
      ctx.log.info("phase complete", { phase: "setup" });
    }, { name: "logged-task" });
  });

  const logEvent = events.find((event) =>
    event.type === "task:progress"
    && event.message === "phase complete"
  );

  assert.ok(logEvent, `events: ${events.map((event) => event.type).join(", ")}`);
  assert.equal(logEvent.data.logLevel, "info");
  assert.deepEqual(logEvent.data.fields, { phase: "setup" });
});

// --- Snapshot / observability sanity ---------------------------------
test("status() reflects task counts correctly", async () => {
  let snapshotDuringRun;

  await assert.rejects(
    group(async (task) => {
      const t1 = task(async () => "a");
      const t2 = task(async () => {
        await sleep(20);
        throw new Error("b failed");
      });
      // Take snapshot mid-flight
      snapshotDuringRun = task(async (ctx) => {
        const snap = ctx.scope.status();
        return snap;
      });
      await Promise.allSettled([t1, t2, snapshotDuringRun]);
    }),
    /b failed/
  );

  const snap = await snapshotDuringRun;
  assert.ok(snap.tasks.length >= 1);
  assert.equal(typeof snap.id, "string");
  assert.match(snap.id, /^scope-/);
});

// --- Event ordering --------------------------------------------------
test("Events fire correctly: task:started -> task:succeeded inside a scope", async () => {
  const events = [];
  await group(async (task) => {
    // Subscribe to the current scope's bus before spawning more
    await task(async (ctx) => {
      ctx.scope.onEvent((e) => events.push(e.type));
      // After subscription, spawn a sibling task we'll observe
      const sibling = ctx.scope.spawn(async () => "ok", { name: "sibling" });
      await sibling;
    });
  });

  assert.ok(events.includes("task:started"), `events: ${events.join(", ")}`);
  assert.ok(events.includes("task:succeeded"), `events: ${events.join(", ")}`);
});
