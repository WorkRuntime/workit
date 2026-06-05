/**
 * Virtual billion-item stream sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs against the compiled package. The sample proves bounded production for a
 * huge logical source by consuming only a prefix and asserting the producer did
 * not materialize the full source.
 */

import assert from "node:assert/strict";
import { work } from "../dist/index.js";

const TOTAL = 1_000_000_000;
const TAKE = 25;
const CONCURRENCY = 16;

let produced = 0;
let active = 0;
let maxActive = 0;

async function* virtualBillionSource() {
  for (let item = 0; item < TOTAL; item++) {
    produced++;
    yield item;
  }
}

const consumed = [];

for await (const item of work(virtualBillionSource())
  .inParallel(CONCURRENCY)
  .map(async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active--;
    return value * 2;
  })
  .stream()) {
  consumed.push(item);
  if (consumed.length === TAKE) break;
}

assert.equal(consumed.length, TAKE);
assert.ok(produced <= TAKE + CONCURRENCY);
assert.ok(maxActive <= CONCURRENCY);
assert.equal(active, 0);

process.stdout.write(`${JSON.stringify({
  sample: "1b-stream",
  total: TOTAL,
  consumed: consumed.length,
  produced,
  concurrency: CONCURRENCY,
  maxActive,
})}\n`);
