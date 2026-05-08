/**
 * Bench 01 -- Promise.all vs run.all.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: 3 tasks. A succeeds at 50ms. B fails at 30ms. C succeeds at 100ms.
 *
 * Native Promise.all: rejects at 30ms. A and C ARE NOT cancelled -- their
 * bodies keep running and "settle silently" past the rejection.
 *
 * run.all: rejects at 30ms. A and C are cancelled at the AbortSignal
 * boundary, their defer cleanups run, and the outer promise does not resolve
 * until cleanup has completed.
 *
 * Output: JSON record with timestamps proving who actually stopped working.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { makeClock, makeProbe, naiveSleep, sleep, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "01-run-all-vs-promise-all", native: null, workit: null };

// --- Native Promise.all --------------------------------------------------
{
  const clock = makeClock();
  const A = makeProbe("A");
  const B = makeProbe("B");
  const C = makeProbe("C");

  const a = (async () => {
    A.startedAt = clock.t();
    await naiveSleep(50);
    A.settledAt = clock.t();
    A.settledAs = "fulfilled";
    return "A";
  })();
  const b = (async () => {
    B.startedAt = clock.t();
    await naiveSleep(30);
    B.settledAt = clock.t();
    B.settledAs = "rejected";
    throw new Error("B failed");
  })();
  const c = (async () => {
    C.startedAt = clock.t();
    await naiveSleep(100);
    C.settledAt = clock.t();
    C.settledAs = "fulfilled";
    return "C";
  })();

  let outerRejectedAt = -1;
  try {
    await Promise.all([a, b, c]);
  } catch (e) {
    outerRejectedAt = clock.t();
  }

  // Wait long enough for the "ghost" tasks to settle.
  await naiveSleep(150);

  result.native = {
    outerRejectedAt,
    A, B, C,
    losersStillRanForMs: {
      A: A.settledAt - outerRejectedAt,
      C: C.settledAt - outerRejectedAt,
    },
    losersWereCancelled: false,
  };
}

// --- WorkIt run.all ------------------------------------------------------
{
  const clock = makeClock();
  const A = makeProbe("A");
  const B = makeProbe("B");
  const C = makeProbe("C");

  const taskA = async (ctx) => {
    A.startedAt = clock.t();
    ctx.defer(() => { A.deferRanAt = clock.t(); });
    ctx.signal.addEventListener("abort", () => { A.signalAbortedAt = clock.t(); }, { once: true });
    try {
      await sleep(50, ctx.signal);
      A.settledAt = clock.t(); A.settledAs = "fulfilled";
      return "A";
    } catch (err) {
      A.settledAt = clock.t();
      A.settledAs = err instanceof CancellationError ? "cancelled" : "rejected";
      throw err;
    }
  };
  const taskB = async () => {
    B.startedAt = clock.t();
    await sleep(30);
    B.settledAt = clock.t(); B.settledAs = "rejected";
    throw new Error("B failed");
  };
  const taskC = async (ctx) => {
    C.startedAt = clock.t();
    ctx.defer(() => { C.deferRanAt = clock.t(); });
    ctx.signal.addEventListener("abort", () => { C.signalAbortedAt = clock.t(); }, { once: true });
    try {
      await sleep(100, ctx.signal);
      C.settledAt = clock.t(); C.settledAs = "fulfilled";
      return "C";
    } catch (err) {
      C.settledAt = clock.t();
      C.settledAs = err instanceof CancellationError ? "cancelled" : "rejected";
      throw err;
    }
  };

  let outerRejectedAt = -1;
  let cancelReasonKind = null;
  try {
    await run.all([taskA, taskB, taskC]);
  } catch (e) {
    outerRejectedAt = clock.t();
  }

  // After the outer promise settles, defers must already have run.
  result.workit = {
    outerRejectedAt,
    A, B, C,
    losersWereCancelled: A.settledAs === "cancelled" && C.settledAs === "cancelled",
    cancellationLatencyFromBFailure: {
      A: A.settledAt - B.settledAt,
      C: C.settledAt - B.settledAt,
    },
    deferRanBeforeOuterReject: {
      A: A.deferRanAt > 0 && A.deferRanAt <= outerRejectedAt,
      C: C.deferRanAt > 0 && C.deferRanAt <= outerRejectedAt,
    },
  };

  // Invariants -- fail loudly if WorkIt regresses.
  assert.equal(A.settledAs, "cancelled", "A must be cancelled by run.all sibling failure");
  assert.equal(C.settledAs, "cancelled", "C must be cancelled by run.all sibling failure");
  assert.ok(A.deferRanAt > 0, "A.defer must run");
  assert.ok(C.deferRanAt > 0, "C.defer must run");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
