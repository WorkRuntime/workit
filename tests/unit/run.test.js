/**
 * Run namespace tests - verifies composition helpers against the scope engine.
 *
 * @author Admilson B. F. Cossa
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  run,
  createContextKey,
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
