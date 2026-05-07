/**
 * Slow-consumer stream memory gate for WorkIt.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This gate proves work().stream() does not prefetch an unbounded source when
 * the consumer is slower than producers. It exercises the compiled public API
 * and keeps the assertion self-terminating for CI.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { work } from "../dist/index.js";

const TOTAL_ITEMS = Number.parseInt(process.env.WORKIT_STREAM_ITEMS ?? "1000000", 10);
const CONCURRENCY = Number.parseInt(process.env.WORKIT_STREAM_CONCURRENCY ?? "32", 10);
const CONSUME_ITEMS = Number.parseInt(process.env.WORKIT_STREAM_CONSUME ?? "500", 10);
const MAX_HEAP_GROWTH_BYTES =
  Number.parseInt(process.env.WORKIT_STREAM_MAX_HEAP_MB ?? "48", 10) * 1024 * 1024;

if (typeof globalThis.gc !== "function") {
  throw new Error("Stream memory gate requires Node to run with --expose-gc.");
}
if (CONSUME_ITEMS >= TOTAL_ITEMS) {
  throw new Error("WORKIT_STREAM_CONSUME must be smaller than WORKIT_STREAM_ITEMS.");
}

let produced = 0;
let consumed = 0;
let active = 0;
let maxActive = 0;

async function* source() {
  for (let index = 0; index < TOTAL_ITEMS; index++) {
    produced++;
    yield index;
  }
}

function forceGc() {
  for (let i = 0; i < 3; i++) globalThis.gc();
}

forceGc();
const before = process.memoryUsage().heapUsed;
const startedAt = performance.now();

for await (const item of work(source())
  .inParallel(CONCURRENCY)
  .map(async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(0);
    active--;
    return value;
  })
  .stream()) {
  assert.equal(item, consumed);
  consumed++;
  await delay(1);
  if (consumed === CONSUME_ITEMS) break;
}

forceGc();
const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - before);
const producedLimit = consumed + CONCURRENCY * 4;

assert.equal(consumed, CONSUME_ITEMS);
assert.equal(active, 0);
assert.ok(maxActive <= CONCURRENCY, `max active ${maxActive} exceeded concurrency ${CONCURRENCY}`);
assert.ok(produced <= producedLimit, `stream prefetched ${produced}; limit ${producedLimit}`);
assert.ok(
  heapGrowth <= MAX_HEAP_GROWTH_BYTES,
  `stream heap growth ${heapGrowth} B exceeded ${MAX_HEAP_GROWTH_BYTES} B`
);

console.log(JSON.stringify({
  streamMemory: "ok",
  totalItems: TOTAL_ITEMS,
  consumed,
  produced,
  concurrency: CONCURRENCY,
  maxActive,
  heapGrowth,
  durationMs: Math.round(performance.now() - startedAt),
}));
