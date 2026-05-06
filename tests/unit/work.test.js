/**
 * Work builder tests - verifies conservative defaults and explicit policies.
 *
 * @author Admilson B. F. Cossa
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { work } from "../../dist/index.js";

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
