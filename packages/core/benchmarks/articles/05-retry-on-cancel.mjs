/**
 * Bench 05 -- signal-unaware retry loop vs run.retry under cancellation.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: a body that throws on every attempt. We trigger an external
 * cancel mid-retry and measure two things:
 *
 *   1. How long the cancel takes to actually stop the loop.
 *   2. How many extra attempts run after the cancel was requested.
 *
 * Baseline retry loop: signal-unaware sleep. Cancel is observed only between
 * attempts, after the next sleep completes. Extra attempts can happen.
 *
 * run.retry: sleep is signal-aware. Cancel rejects the sleep, exits the
 * loop, settles as cancelled (not failed).
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { makeClock, naiveSleep, sleep, signalUnawareRetryLike, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "05-retry-on-cancel", native: null, workit: null };

// --- Signal-unaware retry baseline --------------------------------------
{
  const clock = makeClock();
  let attemptsAfterCancel = 0;
  let cancelRequestedAt = -1;
  let outerSettledAt = -1;
  const controller = new AbortController();

  setTimeout(() => {
    cancelRequestedAt = clock.t();
    controller.abort();
  }, 50);

  try {
    await signalUnawareRetryLike(async (attempt) => {
      if (cancelRequestedAt > 0 && attempt > 1) attemptsAfterCancel++;
      // Body itself doesn't observe the abort -- that's the point.
      await naiveSleep(20);
      throw new Error(`attempt ${attempt} failed`);
    }, { retries: 8, minDelay: 50 });
  } catch {
    outerSettledAt = clock.t();
  }

  result.native = {
    cancelRequestedAt,
    outerSettledAt,
    cancelLatencyMs: outerSettledAt - cancelRequestedAt,
    attemptsAfterCancel,
    settledAs: "rejected",
    signalAwareSleep: false,
  };
}

// --- WorkIt run.retry ---------------------------------------------------
{
  const clock = makeClock();
  let attemptsAfterCancel = 0;
  let cancelRequestedAt = -1;
  let outerSettledAt = -1;
  let settledAs = "pending";
  let cancelReasonKind = null;

  const wrapped = run.retry(async (ctx) => {
    if (cancelRequestedAt > 0 && ctx.attempt > 1) attemptsAfterCancel++;
    await sleep(20, ctx.signal);
    throw new Error(`attempt ${ctx.attempt} failed`);
  }, { times: 8, initialDelay: "50ms", jitter: false, backoff: "fixed" });

  // Drive it through a scope so we can cancel from outside.
  let scopeRef;
  const promise = run.scope(async (scope) => {
    scopeRef = scope;
    await scope.spawn(wrapped, { name: "retried-call" });
  }, { name: "retry-bench" });

  setTimeout(() => {
    cancelRequestedAt = clock.t();
    scopeRef.cancel({ kind: "manual", tag: "external-cancel" });
  }, 50);

  try {
    await promise;
    outerSettledAt = clock.t();
    settledAs = "fulfilled";
  } catch (err) {
    outerSettledAt = clock.t();
    if (err instanceof CancellationError) {
      settledAs = "cancelled";
      cancelReasonKind = err.reason.kind;
    } else {
      settledAs = "rejected";
    }
  }

  result.workit = {
    cancelRequestedAt,
    outerSettledAt,
    cancelLatencyMs: outerSettledAt - cancelRequestedAt,
    attemptsAfterCancel,
    settledAs,
    cancelReasonKind,
    signalAwareSleep: true,
  };

  assert.equal(settledAs, "cancelled", "run.retry must settle as cancelled, not failed, on parent cancel");
  assert.equal(attemptsAfterCancel, 0, "no further attempts after cancel was observed");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
