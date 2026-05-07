/**
 * Core invariant stress tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * These tests apply deterministic pressure to cancellation, cleanup, events,
 * and budget accounting. They are intentionally behavioral, not implementation
 * snapshots.
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  CancellationError,
  ContextBagImpl,
  createBudget,
  run,
} from "../../dist/index.js";

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

test("invariant: sibling failure cancels all running siblings and drains every task cleanup under stress", async () => {
  for (let round = 0; round < 12; round++) {
    const taskCount = 24;
    const failIndex = (round * 7) % taskCount;
    const started = new Set();
    const cleaned = new Set();
    const cancelled = new Set();
    let readyCount = 0;
    let releaseReady;
    const allReady = new Promise((resolve) => {
      releaseReady = resolve;
    });

    const tasks = Array.from({ length: taskCount }, (_, index) => async (ctx) => {
      started.add(index);
      ctx.defer(() => {
        cleaned.add(index);
      });
      readyCount++;
      if (readyCount === taskCount) releaseReady();
      await allReady;

      if (index === failIndex) {
        throw new Error(`planned failure ${round}`);
      }

      try {
        await sleep(5_000, ctx.signal);
        return index;
      } catch (err) {
        if (err instanceof CancellationError && err.reason.kind === "sibling_failed") {
          cancelled.add(index);
        }
        throw err;
      }
    });

    await assert.rejects(run.all(tasks), new RegExp(`planned failure ${round}`));

    assert.equal(started.size, taskCount, `round ${round}: every task started`);
    assert.equal(cleaned.size, taskCount, `round ${round}: every task cleanup ran`);
    assert.equal(cancelled.size, taskCount - 1, `round ${round}: every sibling was cancelled`);
  }
});

test("invariant: child-scope state transitions are observable from the parent event bus", async () => {
  const events = [];

  await run.group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((event) => {
        events.push(event);
      });

      await run.group(async (childTask) => {
        await childTask(async () => "ok", { name: "child.ok" });
      }, { name: "child" });
    }, { name: "observer" });
  }, { name: "parent" });

  assert.ok(events.some((event) => event.type === "scope:opened" && event.parentId !== null));
  assert.ok(events.some((event) => event.type === "task:started" && event.name === "child.ok"));
  assert.ok(events.some((event) => event.type === "task:succeeded"));
  assert.ok(events.some((event) => event.type === "scope:closing" && event.reason === "completed"));
  assert.ok(events.some((event) => event.type === "scope:closed"));
});

test("invariant: first cancellation reason remains authoritative", async () => {
  const reasons = [];

  await assert.rejects(
    run.group(async (task) => {
      const handle = task(async (ctx) => {
        ctx.scope.onCancel((reason) => {
          reasons.push(reason);
        });
        ctx.scope.cancel({ kind: "manual", tag: "first" });
        ctx.scope.cancel({ kind: "manual", tag: "second" });
        await sleep(100, ctx.signal);
      }, { name: "cancel.once" });
      await handle;
    }),
    CancellationError
  );

  assert.deepEqual(reasons, [{ kind: "manual", tag: "first" }]);
});

test("invariant: concurrent budget charges are exact and failed charges do not mutate stored budget", async () => {
  const Budget = createBudget("InvariantBudget", { unit: "ops" });
  const context = new ContextBagImpl().with(Budget, { limit: 200, spent: 0, unit: "ops" });

  await run.group(async (task) => {
    const handles = Array.from({ length: 200 }, () => task(async (ctx) => {
      ctx.consume(Budget, 1);
    }, { name: "budget.charge" }));
    await Promise.all(handles);
  }, { context });

  assert.deepEqual(context.get(Budget), { limit: 200, spent: 200, unit: "ops" });

  await assert.rejects(
    run.group(async (task) => {
      await task(async (ctx) => {
        ctx.consume(Budget, 1);
      }, { name: "budget.overrun" });
    }, { context }),
    (err) => err.name === "BudgetExceededError" && err.spent === 201 && err.attempted === 1
  );

  assert.deepEqual(context.get(Budget), { limit: 200, spent: 200, unit: "ops" });
});
