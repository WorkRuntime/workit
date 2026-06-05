/**
 * Bench 09 -- work(asyncIter).inParallel(N).map().stream() lazy producer.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: a 1,000,000,000-row async generator. The consumer takes 25 items
 * then `break`s. The invariant the article claims:
 *
 *   produced <= TAKE + CONCURRENCY      (the producer paused as soon as the
 *                                       inflight slots were full)
 *   maxActive <= CONCURRENCY            (hard concurrency cap)
 *   active === 0 after break           (every in-flight slot was cancelled
 *                                       or completed cleanly)
 *
 * Comparison shape: the "naive eager" baseline pulls items as fast as the
 * source yields and starts a worker per item up to a buffer cap. It does
 * NOT pause the producer when the consumer breaks -- every prefetched item
 * keeps running until completion. We measure how many items it produced
 * before the consumer broke.
 */

import assert from "node:assert/strict";
import { work } from "../../dist/index.js";
import { makeClock, jsonReplacer } from "./lib/baselines.mjs";

const TOTAL = 1_000_000_000;
const TAKE = 25;
const CONCURRENCY = 16;

const result = { bench: "09-stream-1b-lazy", naive: null, workit: null };

// --- Naive eager pre-buffer baseline ------------------------------------
{
  const clock = makeClock();
  let produced = 0;
  let active = 0;
  let maxActive = 0;
  const PREFETCH = 256;       // typical "queue ahead" knob

  async function* virtualBillion() {
    for (let i = 0; i < TOTAL; i++) { produced++; yield i; }
  }
  const iter = virtualBillion();

  // Pre-fill PREFETCH inflight workers; do NOT pause when consumer breaks.
  const inflight = new Map();
  let nextIdx = 0;
  let done = false;

  async function refill() {
    while (!done && inflight.size < PREFETCH) {
      const next = await iter.next();
      if (next.done) { done = true; break; }
      const idx = nextIdx++;
      active++; if (active > maxActive) maxActive = active;
      const p = (async () => {
        await Promise.resolve();              // simulate trivial async work
        active--;
        return { idx, value: next.value * 2 };
      })();
      inflight.set(idx, p);
    }
  }

  await refill();
  const taken = [];
  while (taken.length < TAKE && inflight.size > 0) {
    const winner = await Promise.race(inflight.values());
    inflight.delete(winner.idx);
    taken.push(winner.value);
    await refill();
  }

  // Even after the consumer "breaks", the prefetched ones keep running.
  await Promise.allSettled(inflight.values());
  const settledAt = clock.t();

  result.naive = {
    settledAt,
    consumed: taken.length,
    produced,
    prefetch: PREFETCH,
    maxActive,
    activeAfter: active,
  };
}

// --- WorkIt work().inParallel(N).map().stream() -------------------------
{
  const clock = makeClock();
  let produced = 0;
  let active = 0;
  let maxActive = 0;

  async function* virtualBillion() {
    for (let i = 0; i < TOTAL; i++) { produced++; yield i; }
  }

  const taken = [];
  for await (const value of work(virtualBillion())
    .inParallel(CONCURRENCY)
    .map(async (n) => {
      active++; if (active > maxActive) maxActive = active;
      await Promise.resolve();
      active--;
      return n * 2;
    })
    .stream()) {
    taken.push(value);
    if (taken.length === TAKE) break;
  }
  const settledAt = clock.t();

  result.workit = {
    settledAt,
    consumed: taken.length,
    produced,
    concurrency: CONCURRENCY,
    maxActive,
    activeAfter: active,
    producedBound: TAKE + CONCURRENCY,
  };

  // Invariants
  assert.equal(taken.length, TAKE, "must consume exactly TAKE items");
  assert.ok(produced <= TAKE + CONCURRENCY, `produced (${produced}) must be <= TAKE + CONCURRENCY (${TAKE + CONCURRENCY})`);
  assert.ok(maxActive <= CONCURRENCY, `maxActive (${maxActive}) must be <= CONCURRENCY (${CONCURRENCY})`);
  assert.equal(active, 0, "no in-flight slots may remain after break");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
