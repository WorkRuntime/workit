/**
 * Bench 12 -- try/finally vs run.bracket under cancellation, error, and
 * hanging cleanup paths.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Five scenarios prove the bracket contract:
 *
 *   A. success                -- [acquire, use, release], release runs once.
 *   B. use_throws             -- release runs once with the resource;
 *                              the original error propagates.
 *   C. acquire_throws         -- release does NOT run.
 *   D. parent_cancel_during_use -- release runs, outer rejects with
 *                              CancellationError carrying the parent's reason.
 *   E. hanging_release        -- `try/finally` would deadlock the caller forever;
 *                              run.bracket bounds the cleanup with
 *                              CleanupOpts.timeout and surfaces the timeout.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { makeClock, sleep, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "12-bracket-vs-try-finally" };

// --- A -- success ---------------------------------------------------------
{
  const order = [];
  const out = await run.scope(async (scope) => scope.spawn(run.bracket(
    async () => { order.push("acquire"); return { id: "RES-A" }; },
    async (res) => { order.push("use"); return res.id + ":used"; },
    async (res) => { order.push(`release:${res.id}`); },
  )));
  result.A_success = { order, out, releaseCount: order.filter((s) => s.startsWith("release")).length };
  assert.deepEqual(order, ["acquire", "use", "release:RES-A"]);
  assert.equal(out, "RES-A:used");
}

// --- B -- use throws ------------------------------------------------------
{
  const order = [];
  let caughtMessage = null;
  try {
    await run.scope(async (scope) => scope.spawn(run.bracket(
      async () => { order.push("acquire"); return { id: "RES-B" }; },
      async () => { order.push("use"); throw new Error("use-failed"); },
      async (res) => { order.push(`release:${res.id}`); },
    )));
  } catch (err) { caughtMessage = err?.message ?? null; }

  result.B_use_throws = {
    order,
    caughtMessage,
    releaseRanWithResource: order.includes("release:RES-B"),
  };
  assert.deepEqual(order, ["acquire", "use", "release:RES-B"]);
  assert.equal(caughtMessage, "use-failed");
}

// --- C -- acquire throws --------------------------------------------------
{
  const order = [];
  let caughtMessage = null;
  try {
    await run.scope(async (scope) => scope.spawn(run.bracket(
      async () => { order.push("acquire"); throw new Error("acquire-failed"); },
      async () => { order.push("use"); },
      async () => { order.push("release"); },
    )));
  } catch (err) { caughtMessage = err?.message ?? null; }

  result.C_acquire_throws = {
    order,
    caughtMessage,
    releaseRan: order.includes("release"),
  };
  assert.deepEqual(order, ["acquire"]);
  assert.equal(caughtMessage, "acquire-failed");
}

// --- D -- parent cancel during use ----------------------------------------
{
  const clock = makeClock();
  const order = [];
  let releasedAt = -1;
  let outerSettledClass = null;
  let outerCancelReasonKind = null;

  let scopeRef;
  const promise = run.scope(async (scope) => {
    scopeRef = scope;
    await scope.spawn(run.bracket(
      async () => { order.push("acquire"); return { id: "RES-D" }; },
      async (res, ctx) => { order.push("use"); await sleep(200, ctx.signal); return res.id; },
      async (res) => { order.push(`release:${res.id}`); releasedAt = clock.t(); },
    ));
  });

  setTimeout(() => scopeRef.cancel({ kind: "manual", tag: "parent-cancel" }), 30);

  try { await promise; } catch (err) {
    outerSettledClass = err?.constructor?.name ?? "Unknown";
    if (err instanceof CancellationError) outerCancelReasonKind = err.reason.kind;
  }

  result.D_parent_cancel_during_use = {
    order,
    releasedAt,
    outerSettledClass,
    outerCancelReasonKind,
  };
  assert.ok(order.includes("release:RES-D"), "release must run on parent cancel");
  assert.equal(outerSettledClass, "CancellationError");
  assert.equal(outerCancelReasonKind, "manual");
}

// --- E -- hanging release: try/finally vs run.bracket ---------------------
{
  // Naive try/finally with a hanging cleanup function.
  // We give it 250ms to bail out via a manual timeout race; if the bracket-style
  // timeout were in place this would never run forever. The test of the
  // The baseline below verifies the absence of bounded cleanup in raw try/finally.
  const clock = makeClock();
  let nativeOuterSettledAt = -1;
  let nativeOuterSettledClass = null;
  let nativeReleaseCompleted = false;
  const nativeRace = await Promise.race([
    (async () => {
      try {
        try {
          /* use */ return "value";
        } finally {
          // Hanging cleanup -- never resolves.
          await new Promise(() => {});
          nativeReleaseCompleted = true;
        }
      } catch (e) { return e; }
    })().then(
      (v) => ({ outcome: "fulfilled", at: clock.t(), value: v }),
      (e) => ({ outcome: "rejected",  at: clock.t(), error: e?.message ?? null }),
    ),
    sleep(250).then(() => ({ outcome: "still_pending_after_250ms", at: clock.t() })),
  ]);
  nativeOuterSettledAt = nativeRace.at;
  nativeOuterSettledClass = nativeRace.outcome;

  // run.bracket with hanging release + CleanupOpts.timeout
  const clock2 = makeClock();
  let bracketSettledAt = -1;
  let bracketSettledClass = null;
  let cleanupEvents = [];
  try {
    await run.scope(async (scope) => {
      scope.onEvent((e) => {
        if (e.type === "task:cleanup_timeout" || e.type === "task:cleanup_failed") {
          cleanupEvents.push(e.type);
        }
      });
      await scope.spawn(run.bracket(
        async () => ({ id: "RES-E" }),
        async () => "value",
        async () => { await new Promise(() => {}); },        // hanging cleanup
        { timeout: "150ms" },                                 // bounded
      ));
    });
    bracketSettledAt = clock2.t();
    bracketSettledClass = "fulfilled";
  } catch (err) {
    bracketSettledAt = clock2.t();
    bracketSettledClass = err?.constructor?.name ?? "Unknown";
  }

  result.E_hanging_release = {
    native: {
      outerSettledAt: nativeOuterSettledAt,
      outcome: nativeOuterSettledClass,
      releaseCompleted: nativeReleaseCompleted,
    },
    workit: {
      cleanupTimeoutMs: 150,
      bracketSettledAt,
      bracketSettledClass,
      cleanupEventsObserved: cleanupEvents,
    },
  };

  assert.equal(nativeOuterSettledClass, "still_pending_after_250ms",
    "native try/finally with hanging cleanup must NOT settle within 250ms");
  assert.ok(bracketSettledAt < 250,
    `run.bracket must settle within the cleanup timeout; got ${bracketSettledAt}ms`);
  assert.ok(cleanupEvents.includes("task:cleanup_timeout"),
    "task:cleanup_timeout event must fire when cleanup exceeds the bound");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
