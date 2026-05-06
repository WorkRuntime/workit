/**
 * Work builder tests - verifies conservative defaults and explicit policies.
 *
 * @author Admilson B. F. Cossa
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { CancellationError, work } from "../../dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("work().do runs sequentially by default", async () => {
  let active = 0;
  let maxActive = 0;

  const output = await work([1, 2, 3]).do(async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(10);
    active--;
    return item * 2;
  });

  assert.equal(output.mode, "fail");
  assert.deepEqual(output.results, [2, 4, 6]);
  assert.equal(maxActive, 1);
});

test("work().inParallel applies an explicit concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;

  const output = await work([1, 2, 3, 4]).inParallel(2).do(async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(10);
    active--;
    return item;
  });

  assert.deepEqual(output.results, [1, 2, 3, 4]);
  assert.equal(maxActive, 2);
});

test("work().onError continue returns results and item errors", async () => {
  const output = await work([1, 2, 3]).onError("continue").do(async (item) => {
    if (item === 2) throw new Error("bad item");
    return item * 10;
  });

  assert.equal(output.mode, "continue");
  assert.deepEqual(output.results, [10, 30]);
  assert.equal(output.errors.length, 1);
  assert.equal(output.errors[0].index, 1);
});

test("work().onError collect returns settled results", async () => {
  const output = await work([1, 2]).onError("collect").do(async (item) => {
    if (item === 2) throw new Error("bad item");
    return item;
  });

  assert.equal(output.mode, "collect");
  assert.deepEqual(output.results.map((item) => item.status), ["fulfilled", "rejected"]);
});

test("work builder map filter tap collect and stream operate on transformed values", async () => {
  const tapped = [];
  const builder = work([1, 2, 3, 4])
    .map((item) => item * 2)
    .filter((item) => item > 4)
    .tap((item) => tapped.push(item));

  assert.deepEqual(await builder.collect(), [6, 8]);
  assert.deepEqual(tapped, [6, 8]);

  const streamed = [];
  for await (const item of builder.stream()) streamed.push(item);
  assert.deepEqual(streamed, [6, 8]);

  const empty = [];
  for await (const item of work([]).stream()) empty.push(item);
  assert.deepEqual(empty, []);
});

test("work().stream is backpressured over virtual billion sources and respects concurrency", async () => {
  const total = 1_000_000_000;
  let produced = 0;
  let active = 0;
  let maxActive = 0;

  async function* virtualBillionSource() {
    for (let item = 0; item < total; item++) {
      produced++;
      yield item;
    }
  }

  const streamed = [];
  for await (const item of work(virtualBillionSource())
    .inParallel(16)
    .map(async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(1);
      active--;
      return value * 2;
    })
    .stream()) {
    streamed.push(item);
    if (streamed.length === 25) break;
  }

  assert.equal(streamed.length, 25);
  assert.ok(produced <= 41);
  assert.ok(maxActive <= 16);
  assert.equal(active, 0);
});

test("work().stream propagates failures and cancels active siblings", async () => {
  let slowCancelled = false;

  await assert.rejects(
    async () => {
      for await (const _item of work([1, 2])
        .inParallel(2)
        .map(async (value, ctx) => {
          if (value === 1) throw new Error("stream failed");
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 1_000);
              ctx.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(ctx.signal.reason);
              }, { once: true });
            });
          } catch (err) {
            slowCancelled = err instanceof CancellationError
              && err.reason.kind === "sibling_failed";
            throw err;
          }
          return value;
        })
        .stream()) {
        assert.fail("stream should not yield after a mapped failure");
      }
    },
    /stream failed/
  );

  assert.equal(slowCancelled, true);
});

test("work().withRetry applies retry policy to item execution", async () => {
  let attempts = 0;

  const output = await work([1]).withRetry({ times: 3, initialDelay: 1, maxDelay: 1, jitter: false }).do(async () => {
    attempts++;
    if (attempts < 3) throw new Error("again");
    return "ok";
  });

  assert.deepEqual(output.results, ["ok"]);
  assert.equal(attempts, 3);
});
