/**
 * Bench 10 -- slow consumer pauses the producer.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: a fast producer (yields every microtask), a 16-wide map, a slow
 * consumer (~5 ms per item).
 *
 * Without backpressure: producer races ahead, prefetched items pile up, heap
 * grows linearly with the producer rate x consumer lag.
 *
 * With WorkIt's stream(): the consumer's await pause holds the producer at
 * `inflight + N` items at a time. We measure produced vs consumed over time.
 */

import assert from "node:assert/strict";
import { work } from "../../dist/index.js";
import { makeClock, jsonReplacer } from "./lib/baselines.mjs";

const SOURCE_SIZE = 5_000;
const CONCURRENCY = 16;
const CONSUME_DELAY_MS = 5;
const TAKE = 200;

const result = { bench: "10-stream-slow-consumer", workit: null };

// --- WorkIt -- slow consumer ---------------------------------------------
{
  const clock = makeClock();
  let produced = 0;
  let active = 0;
  let maxActive = 0;
  let producedAtFirstConsume = -1;
  let producedAtLastConsume = -1;

  async function* source() {
    for (let i = 0; i < SOURCE_SIZE; i++) { produced++; yield i; }
  }

  const consumed = [];
  for await (const value of work(source())
    .inParallel(CONCURRENCY)
    .map(async (n) => {
      active++; if (active > maxActive) maxActive = active;
      await Promise.resolve();
      active--;
      return n * 10;
    })
    .stream()) {
    if (producedAtFirstConsume < 0) producedAtFirstConsume = produced;
    consumed.push(value);
    producedAtLastConsume = produced;
    await new Promise((r) => setTimeout(r, CONSUME_DELAY_MS));
    if (consumed.length === TAKE) break;
  }
  const elapsedMs = clock.t();

  result.workit = {
    sourceSize: SOURCE_SIZE,
    take: TAKE,
    concurrency: CONCURRENCY,
    consumeDelayMs: CONSUME_DELAY_MS,
    consumed: consumed.length,
    produced,
    producedAtFirstConsume,
    producedAtLastConsume,
    maxActive,
    activeAfterBreak: active,
    elapsedMs,
    producerOvershoot: produced - consumed.length,
    producerOvershootBound: CONCURRENCY + 1,    // map slot + buffered next
  };

  // Invariants
  assert.equal(consumed.length, TAKE, "must consume exactly TAKE items");
  assert.ok(maxActive <= CONCURRENCY, `maxActive (${maxActive}) must be <= CONCURRENCY`);
  assert.ok(
    produced - consumed.length <= CONCURRENCY + 1,
    `producer overshoot (${produced - consumed.length}) must stay within CONCURRENCY + 1`,
  );
  assert.equal(active, 0, "all in-flight slots cancelled or settled");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
