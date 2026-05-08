/**
 * Bench 03 -- Promise.any vs run.any.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: 3 tasks. A fails at 30ms. B succeeds at 50ms. C succeeds at 100ms.
 *
 * Native Promise.any: resolves with B at 50ms. C keeps running and bills.
 *
 * run.any: resolves with B at 50ms. C is cancelled at the AbortSignal
 * boundary, defer cleanups run before the outer promise resolves.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { makeClock, makeProbe, naiveSleep, sleep, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "03-run-any-vs-promise-any", native: null, workit: null };

// --- Native Promise.any ------------------------------------------------
{
  const clock = makeClock();
  const A = makeProbe("A"), B = makeProbe("B"), C = makeProbe("C");

  const make = (probe, kind, ms) => (async () => {
    probe.startedAt = clock.t();
    await naiveSleep(ms);
    probe.settledAt = clock.t();
    probe.settledAs = kind;
    if (kind === "rejected") throw new Error(`${probe.name} failed`);
    return probe.name;
  })();

  const winner = await Promise.any([make(A, "rejected", 30), make(B, "fulfilled", 50), make(C, "fulfilled", 100)]);
  const winnerSettledAt = clock.t();

  await naiveSleep(150);

  result.native = {
    winner,
    winnerSettledAt,
    A, B, C,
    cStillRanForMs: C.settledAt - winnerSettledAt,
    losersWereCancelled: false,
  };
}

// --- WorkIt run.any ----------------------------------------------------
{
  const clock = makeClock();
  const A = makeProbe("A"), B = makeProbe("B"), C = makeProbe("C");

  const make = (probe, kind, ms) => async (ctx) => {
    probe.startedAt = clock.t();
    ctx.defer(() => { probe.deferRanAt = clock.t(); });
    ctx.signal.addEventListener("abort", () => { probe.signalAbortedAt = clock.t(); }, { once: true });
    try {
      await sleep(ms, ctx.signal);
      probe.settledAt = clock.t();
      probe.settledAs = kind === "rejected" ? "rejected" : "fulfilled";
      if (kind === "rejected") throw new Error(`${probe.name} failed`);
      return probe.name;
    } catch (err) {
      probe.settledAt = clock.t();
      if (err instanceof CancellationError) {
        probe.settledAs = "cancelled";
        probe.cancelReasonKind = err.reason.kind;
      }
      throw err;
    }
  };

  const winner = await run.any([
    make(A, "rejected", 30),
    make(B, "fulfilled", 50),
    make(C, "fulfilled", 100),
  ]);
  const winnerSettledAt = clock.t();

  result.workit = {
    winner,
    winnerSettledAt,
    A, B, C,
    cWasCancelled: C.settledAs === "cancelled",
    cancelLatencyForC: C.settledAt - winnerSettledAt,
    deferRanForC: C.deferRanAt > 0 && C.deferRanAt <= winnerSettledAt,
  };

  assert.equal(winner, "B");
  assert.equal(C.settledAs, "cancelled", "C must be cancelled when run.any picks B");
  assert.ok(C.deferRanAt > 0, "C.defer must run before run.any resolves");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
