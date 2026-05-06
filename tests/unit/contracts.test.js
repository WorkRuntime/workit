/**
 * Public contract tests for boundary validation and failure policy.
 *
 * @author Admilson B. F. Cossa
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  CancellationError,
  ContextBagImpl,
  WorkAggregateError,
  createContextKey,
  group,
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

test("context keys support defaults and fail fast for required values", () => {
  const Region = createContextKey("Region", "global");
  const Missing = createContextKey("Missing");
  const context = new ContextBagImpl();

  assert.equal(context.get(Region), "global");
  assert.equal(context.has(Region), false);
  assert.throws(() => context.getOrThrow(Missing), /Context key "Missing" not set/);
  assert.equal(context.with(Region, "local").get(Region), "local");
});

test("duration policies reject malformed timeout durations at wrapper creation", () => {
  assert.throws(() => run.timeout(async () => "x", -1), /Invalid duration/);
  assert.throws(() => run.timeout(async () => "x", Number.POSITIVE_INFINITY), /Invalid duration/);
  assert.throws(() => run.timeout(async () => "x", "1.5s"), /Invalid duration string/);
});

test("retry rejects malformed computed backoff durations when retrying", async () => {
  await assert.rejects(
    group(async (task) => task(run.retry(async () => {
      throw new Error("retry me");
    }, { times: 2, backoff: () => "soon" }))),
    /Invalid duration string/
  );
});

test("aggregate helpers expose empty-input contract failures", async () => {
  await assert.rejects(run.race([]), WorkAggregateError);
  await assert.rejects(run.any([]), WorkAggregateError);
  await assert.rejects(async () => run.pool(0, []), /positive integer/);
});

test("run.allSettled preserves fulfillment rejection and cancellation", async () => {
  const results = await run.allSettled([
    async () => "ok",
    async () => {
      throw new Error("ordinary failure");
    },
    async () => {
      throw new CancellationError({ kind: "manual", tag: "contract-test" });
    },
  ]);

  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "cancelled"]);
});

test("run.series stops at the first failed task", async () => {
  const seen = [];

  await assert.rejects(
    run.series([
      async () => {
        seen.push("first");
        return 1;
      },
      async () => {
        seen.push("second");
        throw new Error("stop");
      },
      async () => {
        seen.push("third");
        return 3;
      },
    ]),
    /stop/
  );

  assert.deepEqual(seen, ["first", "second"]);
});

test("retry and fallback preserve cancellation errors", async () => {
  const reason = { kind: "manual", tag: "stop-now" };
  const cancelled = async () => {
    throw new CancellationError(reason);
  };

  await assert.rejects(group(async (task) => task(run.retry(cancelled, 3))), CancellationError);
  await assert.rejects(group(async (task) => task(run.fallback(cancelled, async () => "fallback"))), CancellationError);
});

test("run.hedge rejects with aggregate error when every attempt fails", async () => {
  let attempts = 0;
  const wrapped = run.hedge(async () => {
    attempts++;
    throw new Error(`failed-${attempts}`);
  }, { after: 1, max: 3 });

  await assert.rejects(group(async (task) => task(wrapped)), WorkAggregateError);
  assert.equal(attempts, 3);
});

test("run.supervise respects the restart limit", async () => {
  let attempts = 0;

  await assert.rejects(
    run.supervise(async () => {
      attempts++;
      throw new Error("still down");
    }, { maxRestarts: 1, backoff: () => 1 }),
    /still down/
  );

  assert.equal(attempts, 2);
});

test("scope cancellation cancels hedged attempts and prevents delayed starts", async () => {
  let attempts = 0;

  await assert.rejects(
    group(async (task) => {
      const handle = task(run.hedge(async (ctx) => {
        attempts++;
        await sleep(1000, ctx.signal);
        return "late";
      }, { after: 20, max: 3 }));

      await sleep(5);
      handle.cancel("test-cancel");
      await handle;
    }),
    CancellationError
  );

  await sleep(60);
  assert.equal(attempts, 1);
});
