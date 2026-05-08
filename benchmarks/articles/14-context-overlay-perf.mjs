/**
 * Bench 14 -- naive Map-clone context vs WorkIt overlay context.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: pre-fill a context bag with 5,000 keys. Then call .with(key, val)
 * 100 times in succession (typical agent stack depth x repeated overrides).
 *
 * Naive baseline: every .with() clones the underlying Map. O(N) per call;
 * the chain is O(M·N) for M calls over N keys.
 *
 * WorkIt overlay: every .with() returns a child bag that points to the parent
 * and stores a single-key delta. O(1) per .with(). Lookup walks the chain.
 *
 * The article's claim: representative clone-vs-overlay timing for 100x5000.
 * That bound is documented in `npm run check:context-performance`.
 */

import assert from "node:assert/strict";
import { ContextBagImpl, createContextKey } from "../../dist/index.js";
import { jsonReplacer } from "./lib/baselines.mjs";

const KEYS = 5_000;
const WITH_CALLS = 100;
const result = { bench: "14-context-overlay-perf", naive: null, workit: null };

// --- Pre-create keys and values shared across both baselines ------------
const keys = Array.from({ length: KEYS }, (_, i) => createContextKey(`k-${i}`));
const seedValues = Array.from({ length: KEYS }, (_, i) => `v-${i}`);
const overrideKey = keys[Math.floor(KEYS / 2)];

// --- Naive Map-clone context (inline implementation) --------------------
{
  class NaiveBag {
    constructor(map) { this.map = map ?? new Map(); }
    get(key) { return this.map.get(key); }
    with(key, value) {
      const next = new Map(this.map);    // O(N) clone every time
      next.set(key, value);
      return new NaiveBag(next);
    }
  }
  let bag = new NaiveBag();
  for (let i = 0; i < KEYS; i++) bag = bag.with(keys[i], seedValues[i]);

  const t0 = performance.now();
  let cur = bag;
  for (let i = 0; i < WITH_CALLS; i++) cur = cur.with(overrideKey, `override-${i}`);
  const elapsedMs = performance.now() - t0;

  result.naive = {
    keys: KEYS,
    withCalls: WITH_CALLS,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    perCallMs: Number((elapsedMs / WITH_CALLS).toFixed(4)),
    deepestLookup: cur.get(overrideKey),
  };
}

// --- WorkIt overlay context ---------------------------------------------
{
  let bag = new ContextBagImpl();
  for (let i = 0; i < KEYS; i++) bag = bag.with(keys[i], seedValues[i]);

  const t0 = performance.now();
  let cur = bag;
  for (let i = 0; i < WITH_CALLS; i++) cur = cur.with(overrideKey, `override-${i}`);
  const elapsedMs = performance.now() - t0;

  result.workit = {
    keys: KEYS,
    withCalls: WITH_CALLS,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    perCallMs: Number((elapsedMs / WITH_CALLS).toFixed(4)),
    deepestLookup: cur.get(overrideKey),
    speedupVsNaive: Number((result.naive.elapsedMs / Math.max(elapsedMs, 1e-6)).toFixed(0)),
  };

  // The published gate is < 10ms; we assert that floor here.
  assert.ok(elapsedMs < 10,
    `WorkIt overlay context must complete 100 .with() over 5000 keys in under 10ms; got ${elapsedMs.toFixed(3)}ms`);

  // Correctness -- both bags must resolve the deepest override the same way.
  assert.equal(result.workit.deepestLookup, result.naive.deepestLookup);

  // We also assert the naive baseline is at least 10x slower so the bench is
  // meaningful (not tied to a specific number, since hardware varies).
  assert.ok(result.naive.elapsedMs > elapsedMs * 10,
    `naive baseline (${result.naive.elapsedMs}ms) must be >=10x slower than overlay (${elapsedMs.toFixed(3)}ms)`);
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
