/**
 * Work builder tests - verifies conservative defaults and explicit policies.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
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

test("work().withRateLimit spaces item starts while preserving bounded concurrency", async () => {
  const starts = [];

  const output = await work([1, 2, 3])
    .inParallel(3)
    .withRateLimit(20)
    .do(async (item) => {
      starts.push(Date.now());
      return item;
    });

  assert.deepEqual(output.results, [1, 2, 3]);
  assert.ok(starts[1] - starts[0] >= 25);
  assert.ok(starts[2] - starts[1] >= 25);
  assert.throws(() => work([1]).withRateLimit(0), /positive finite/);
});

test("work().withRateLimit removes abort listeners after completed waits", async () => {
  const signals = [];

  const output = await work([1, 2])
    .inParallel(2)
    .withRateLimit(20)
    .do(async (item, ctx) => {
      signals.push(ctx.signal);
      return item;
    });

  assert.deepEqual(output.results, [1, 2]);
  assert.equal(signals.length, 2);
  assert.equal(getEventListeners(signals[1], "abort").length, 0);
});

test("work fluent progress and completion hooks observe item-level outcomes", async () => {
  const progress = [];
  const done = [];

  const output = await work([1, 2, 3])
    .onProgress((event) => progress.push({ index: event.index, pct: event.pct, item: event.item }))
    .onItemDone((event) => done.push(event.status))
    .filter((item) => item !== 3)
    .onError("continue")
    .do(async (item, ctx) => {
      ctx.report({ pct: item / 3, message: `item-${item}`, data: { item } });
      if (item === 2) throw new Error("item failed");
      return item * 10;
    });

  assert.equal(output.mode, "continue");
  assert.deepEqual(output.results, [10]);
  assert.equal(output.errors.length, 1);
  assert.deepEqual(progress, [
    { index: 0, pct: 1 / 3, item: 1 },
    { index: 1, pct: 2 / 3, item: 2 },
  ]);
  assert.deepEqual(done, ["fulfilled", "rejected", "cancelled"]);
});

test("work fluent progress hook preserves empty progress reports", async () => {
  const progress = [];

  await work([1])
    .onProgress((event) => progress.push(event))
    .do(async (_item, ctx) => {
      ctx.report({});
      return "ok";
    });

  assert.equal(progress.length, 1);
  assert.equal("pct" in progress[0], false);
  assert.equal("message" in progress[0], false);
  assert.equal("data" in progress[0], false);
});

test("work().onCancel partial returns completed and cancelled item receipts", async () => {
  const output = await work([1, 2])
    .inParallel(2)
    .withTimeout(1)
    .onCancel("partial")
    .do(async (item, ctx) => {
      if (item === 1) return "early";
      await sleep(50, ctx.signal);
      return "late";
    });

  assert.equal(output.mode, "partial");
  assert.deepEqual(output.results, ["early"]);
  assert.equal(output.cancelled.length, 1);
  assert.equal(output.cancelled[0].reason.kind, "timeout");

  const completed = await work([1])
    .onCancel("partial")
    .do(async (item) => item);
  assert.deepEqual(completed, { mode: "fail", results: [1] });

  await assert.rejects(
    work([1])
      .onCancel("partial")
      .do(async () => {
        throw new Error("ordinary failure");
      }),
    /ordinary failure/
  );
});

test("work().withRateLimit releases queued waits when task timeout cancels them", async () => {
  const output = await work([1, 2])
    .inParallel(2)
    .withRateLimit(1)
    .withTimeout(5)
    .onCancel("partial")
    .do(async (item) => item);

  assert.equal(output.mode, "partial");
  assert.deepEqual(output.results, [1]);
  assert.equal(output.cancelled.length, 1);
  assert.equal(output.cancelled[0].reason.kind, "timeout");
});
