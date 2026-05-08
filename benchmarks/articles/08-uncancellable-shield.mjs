/**
 * Bench 08 -- run.uncancellable shield contract.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Three scenarios prove the shield's runtime contract:
 *
 *   A. parent_cancel_during_body -- parent scope cancels mid-body. The body
 *      runs to completion and observes its OWN signal (not the parent's).
 *      After the body returns, the shield rethrows the original cancel.
 *
 *   B. shield_timeout -- shield's own timeout fires while the body is inside.
 *      The body sees a TimeoutError on its own signal.
 *
 *   C. nested_shields -- outer scope cancels while two nested shields are
 *      active. Both bodies complete. The outer cancel reason is preserved
 *      and rethrown after the bodies finish.
 *
 * Note: run.uncancellable(body, opts) returns a TaskFn -- it must be spawned
 * into a scope. We use scope.spawn(...) below.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { makeClock, sleep, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "08-uncancellable-shield" };

// --- Scenario A -- parent cancel during body -----------------------------
{
  const clock = makeClock();
  let bodyStartedAt = -1;
  let bodyCompletedAt = -1;
  let bodyObservedAbort = false;
  let outerSettledAt = -1;
  let outerSettledAs = "pending";
  let outerCancelReasonKind = null;
  let parentCancelRequestedAt = -1;

  const shielded = run.uncancellable(async (ctx) => {
    bodyStartedAt = clock.t();
    try {
      await sleep(120, ctx.signal);
      bodyCompletedAt = clock.t();
    } catch {
      bodyObservedAbort = true;
    }
  }, { timeout: "1s" });

  let scopeRef;
  const promise = run.scope(async (scope) => {
    scopeRef = scope;
    await scope.spawn(shielded, { name: "shielded" });
  }, { name: "scenario-A" });

  setTimeout(() => {
    parentCancelRequestedAt = clock.t();
    scopeRef.cancel({ kind: "manual", tag: "outer-cancel" });
  }, 30);

  try {
    await promise;
    outerSettledAt = clock.t();
    outerSettledAs = "fulfilled";
  } catch (err) {
    outerSettledAt = clock.t();
    if (err instanceof CancellationError) {
      outerSettledAs = "cancelled";
      outerCancelReasonKind = err.reason.kind;
    } else {
      outerSettledAs = "rejected";
    }
  }

  result.A_parent_cancel_during_body = {
    parentCancelRequestedAt,
    bodyStartedAt,
    bodyCompletedAt,
    bodyObservedAbort,
    outerSettledAt,
    outerSettledAs,
    outerCancelReasonKind,
    bodyOutlivedCancelByMs: bodyCompletedAt - parentCancelRequestedAt,
  };

  assert.ok(bodyStartedAt >= 0, "shielded body must run");
  assert.ok(bodyCompletedAt > 0, "body must complete naturally inside the shield");
  assert.equal(bodyObservedAbort, false, "body's signal must NOT see the parent cancel");
  assert.equal(outerSettledAs, "cancelled", "outer scope must rethrow the original cancel after body");
  assert.equal(outerCancelReasonKind, "manual", "cancel reason must be preserved");
  assert.ok(bodyCompletedAt > parentCancelRequestedAt, "body must outlive the cancel request");
}

// --- Scenario B -- shield timeout while body is inside -------------------
{
  const clock = makeClock();
  let bodyStartedAt = -1;
  let bodyObservedAbort = false;
  let bodyAbortReasonClass = null;
  let outerSettledAt = -1;
  let outerSettledClass = null;

  const shielded = run.uncancellable(async (ctx) => {
    bodyStartedAt = clock.t();
    try {
      // Body sleeps longer than the shield's own timeout
      await sleep(2_000, ctx.signal);
    } catch (err) {
      bodyObservedAbort = true;
      bodyAbortReasonClass = err?.constructor?.name ?? "Unknown";
      throw err;
    }
  }, { timeout: "100ms" });

  try {
    await run.scope(async (scope) => {
      await scope.spawn(shielded, { name: "shielded-timeout" });
    });
    outerSettledAt = clock.t();
    outerSettledClass = "fulfilled";
  } catch (err) {
    outerSettledAt = clock.t();
    outerSettledClass = err?.constructor?.name ?? "Unknown";
  }

  result.B_shield_timeout = {
    bodyStartedAt,
    bodyObservedAbort,
    bodyAbortReasonClass,
    outerSettledAt,
    outerSettledClass,
  };

  assert.equal(bodyObservedAbort, true, "body must see the shield's own timeout on its signal");
  assert.equal(bodyAbortReasonClass, "TimeoutError", "abort reason inside body must be TimeoutError");
}

// --- Scenario C -- nested shields preserve outer cancel reason -----------
{
  const clock = makeClock();
  let innerCompletedAt = -1;
  let outerInnerCompletedAt = -1;
  let outerSettledAt = -1;
  let outerCancelReasonKind = null;
  let parentCancelRequestedAt = -1;

  const inner = run.uncancellable(async (ctxInner) => {
    await sleep(80, ctxInner.signal);
    innerCompletedAt = clock.t();
  }, { timeout: "1s" });

  const outerShield = run.uncancellable(async (ctxOuter) => {
    // ctxOuter has the shield-local signal; the inner shield wraps again
    await inner(ctxOuter);
    outerInnerCompletedAt = clock.t();
  }, { timeout: "1s" });

  let scopeRef;
  const promise = run.scope(async (scope) => {
    scopeRef = scope;
    await scope.spawn(outerShield, { name: "shielded-nested" });
  }, { name: "scenario-C" });

  setTimeout(() => {
    parentCancelRequestedAt = clock.t();
    scopeRef.cancel({ kind: "manual", tag: "scenario-c-cancel" });
  }, 20);

  try {
    await promise;
  } catch (err) {
    outerSettledAt = clock.t();
    if (err instanceof CancellationError) outerCancelReasonKind = err.reason.kind;
  }

  result.C_nested_shields = {
    parentCancelRequestedAt,
    innerCompletedAt,
    outerInnerCompletedAt,
    outerSettledAt,
    outerCancelReasonKind,
  };

  assert.ok(innerCompletedAt > 0, "innermost body must complete");
  assert.ok(outerInnerCompletedAt > 0, "outer shield body must complete after inner");
  assert.equal(outerCancelReasonKind, "manual", "outer cancel reason preserved through both shields");
  assert.ok(outerSettledAt > parentCancelRequestedAt, "outer must rethrow only after both shields finish");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
