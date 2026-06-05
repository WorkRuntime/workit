/**
 * Bench 04 -- p-limit-style semaphore vs run.pool.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: 10 items. Item index 3 throws at 20ms. Every other item takes
 * 100ms. Concurrency 4.
 *
 * Semaphore baseline: when the failing item throws, queued items KEEP RUNNING.
 * The semaphore has no cancellation. We measure how many items still ran.
 *
 * run.pool: first throw cancels queued and in-flight. We measure that the
 * outer promise rejects fast and that the in-flight items got
 * AbortSignal aborts.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import {
  makeClock, makeProbe, naiveSleep, sleep, pLimitLike, jsonReplacer,
} from "./lib/baselines.mjs";

const ITEMS = 10;
const CONCURRENCY = 4;
const FAILING_INDEX = 3;
const result = { bench: "04-pool-vs-semaphore", native: null, workit: null };

// --- p-limit-style baseline ---------------------------------------------
{
  const clock = makeClock();
  const limit = pLimitLike(CONCURRENCY);
  const probes = Array.from({ length: ITEMS }, (_, i) => makeProbe(`item-${i}`));

  const tasks = probes.map((probe, i) => limit(async () => {
    probe.startedAt = clock.t();
    if (i === FAILING_INDEX) {
      await naiveSleep(20);
      probe.settledAt = clock.t(); probe.settledAs = "rejected";
      throw new Error(`item-${i} failed`);
    }
    await naiveSleep(100);
    probe.settledAt = clock.t(); probe.settledAs = "fulfilled";
    return i;
  }));

  // Use Promise.all: rejects on first throw. Other tasks keep running.
  let outerRejectedAt = -1;
  try {
    await Promise.all(tasks);
  } catch (e) {
    outerRejectedAt = clock.t();
  }

  // Settle: drain everything else by awaiting allSettled so probes capture.
  await Promise.allSettled(tasks);

  const ran = probes.filter((p) => p.settledAt > -1);
  result.native = {
    outerRejectedAt,
    started: probes.filter((p) => p.startedAt > -1).length,
    fulfilledAfterRejection: probes.filter((p) => p.settledAs === "fulfilled" && p.settledAt > outerRejectedAt).length,
    cancelled: 0,
    longestPostRejectionRunMs: Math.max(...ran.map((p) => p.settledAt - outerRejectedAt), 0),
    probes,
  };
}

// --- WorkIt run.pool ----------------------------------------------------
{
  const clock = makeClock();
  const probes = Array.from({ length: ITEMS }, (_, i) => makeProbe(`item-${i}`));

  const tasks = probes.map((probe, i) => async (ctx) => {
    probe.startedAt = clock.t();
    ctx.defer(() => { probe.deferRanAt = clock.t(); });
    ctx.signal.addEventListener("abort", () => { probe.signalAbortedAt = clock.t(); }, { once: true });
    try {
      if (i === FAILING_INDEX) {
        await sleep(20, ctx.signal);
        probe.settledAt = clock.t(); probe.settledAs = "rejected";
        throw new Error(`item-${i} failed`);
      }
      await sleep(100, ctx.signal);
      probe.settledAt = clock.t(); probe.settledAs = "fulfilled";
      return i;
    } catch (err) {
      probe.settledAt = clock.t();
      if (err instanceof CancellationError) {
        probe.settledAs = "cancelled";
        probe.cancelReasonKind = err.reason.kind;
      }
      throw err;
    }
  });

  let outerRejectedAt = -1;
  try {
    await run.pool(CONCURRENCY, tasks);
  } catch (e) {
    outerRejectedAt = clock.t();
  }

  result.workit = {
    outerRejectedAt,
    started: probes.filter((p) => p.startedAt > -1).length,
    fulfilledAfterRejection: probes.filter((p) => p.settledAs === "fulfilled" && p.settledAt > outerRejectedAt).length,
    cancelled: probes.filter((p) => p.settledAs === "cancelled").length,
    notStarted: probes.filter((p) => p.startedAt === -1).length,
    cancelReasonKindsForCancelled: [...new Set(probes.filter((p) => p.cancelReasonKind).map((p) => p.cancelReasonKind))],
    probes,
  };

  // Invariants
  assert.equal(result.workit.fulfilledAfterRejection, 0, "no item must complete after first rejection");
  assert.ok(
    result.workit.cancelled + 1 + result.workit.notStarted === ITEMS - probes.filter((p) => p.settledAs === "fulfilled").length,
    "every started, non-failing item must be cancelled",
  );
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
