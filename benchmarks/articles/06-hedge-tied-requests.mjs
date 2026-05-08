/**
 * Bench 06 -- run.hedge tied-request behavior.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: the body sleeps a configurable amount each call. With
 * { after: "50ms", max: 3 }, run.hedge fires up to two more attempts at
 * 50ms intervals. Whichever finishes first wins; the others cancel.
 *
 * We run two scenarios:
 *
 *   slow:   body sleeps 200ms. Hedges should fire at ~50ms and ~100ms.
 *           First completion at ~200ms. Two losers cancelled.
 *   fast:   body sleeps 30ms. The first call wins before hedge timer.
 *           No hedges fired. No losers.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { makeClock, sleep, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "06-hedge-tied-requests", slow: null, fast: null };

async function runScenario(name, bodyMs, hedgeOpts) {
  const clock = makeClock();
  const fired = [];      // attempt-start timestamps
  const settled = [];    // { kind, t }
  let attemptCounter = 0;

  const hedged = run.hedge(async (ctx) => {
    const id = ++attemptCounter;
    fired.push({ id, t: clock.t() });
    try {
      await sleep(bodyMs, ctx.signal);
      settled.push({ id, kind: "fulfilled", t: clock.t() });
      return id;
    } catch (err) {
      if (err instanceof CancellationError) {
        settled.push({ id, kind: "cancelled", t: clock.t(), reason: err.reason.kind });
      } else {
        settled.push({ id, kind: "rejected", t: clock.t() });
      }
      throw err;
    }
  }, hedgeOpts);

  const winner = await run.scope(async (scope) => {
    return await scope.spawn(hedged, { name: `hedge-${name}` });
  });

  return {
    scenario: name,
    bodyMs,
    hedgeOpts,
    winner,
    attemptsFired: fired.length,
    fired,
    settled,
    losersCancelled: settled.filter((s) => s.kind === "cancelled").length,
  };
}

result.slow = await runScenario("slow", 200, { after: "50ms", max: 3 });
result.fast = await runScenario("fast", 30,  { after: "50ms", max: 3 });

// Invariants
assert.ok(result.slow.attemptsFired >= 2, "slow scenario must fire at least one hedge");
assert.ok(result.slow.attemptsFired <= 3, "max bound must hold");
assert.equal(result.slow.losersCancelled, result.slow.attemptsFired - 1, "every loser must be cancelled");
assert.equal(result.fast.attemptsFired, 1, "fast scenario must not fire a hedge");
assert.equal(result.fast.losersCancelled, 0);

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
