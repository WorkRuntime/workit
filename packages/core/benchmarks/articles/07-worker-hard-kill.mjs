/**
 * Bench 07 -- main-thread cooperative attempt vs offload({ timeout }).
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: a non-cooperative CPU spinner that runs for 5 seconds and
 * writes a late-marker file *after* the loop completes.
 *
 * Native main-thread attempt: an `AbortController` cannot stop the loop.
 * The signal aborts. The loop ignores it. The marker file IS written. The
 * "abort" is a lie.
 *
 * WorkIt offload({ timeout: "200ms" }): the worker thread is terminated by
 * the host. The promise rejects with TimeoutError. The marker file does NOT
 * exist on disk. CI gates the build on this.
 */

import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { TimeoutError, run } from "../../dist/index.js";
import { offload } from "../../dist/worker/index.js";
import { makeClock, jsonReplacer } from "./lib/baselines.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const spinnerURL = new URL("./lib/spinner.mjs", import.meta.url);
const SPIN_MS = 5_000;
const TIMEOUT_MS = 200;

const result = { bench: "07-worker-hard-kill", native: null, workit: null };

// --- Native main-thread "abort" attempt ---------------------------------
// We import the spinner here as a normal module, run it on the main thread,
// and trigger an AbortController after TIMEOUT_MS. The signal CANNOT stop the
// busy loop because there is no await boundary inside it. The late-marker IS
// written.
{
  const clock = makeClock();
  const markerPath = path.join(os.tmpdir(), `workit-bench-07-native-${process.pid}-${Date.now()}.marker`);
  if (existsSync(markerPath)) rmSync(markerPath);
  const controller = new AbortController();
  let abortRequestedAt = -1;
  let abortVisibleAt = -1;
  controller.signal.addEventListener("abort", () => { abortVisibleAt = clock.t(); }, { once: true });
  setTimeout(() => { abortRequestedAt = clock.t(); controller.abort(); }, TIMEOUT_MS);

  const { spin } = await import(spinnerURL.href);
  const finalState = spin({ durationMs: SPIN_MS, markerPath });
  const completedAt = clock.t();

  result.native = {
    abortRequestedAt,
    abortVisibleAt,
    completedAt,
    bodyCompleted: finalState.completed,
    elapsedMs: finalState.elapsedMs,
    markerExists: existsSync(markerPath),
  };
  if (existsSync(markerPath)) rmSync(markerPath);
}

// --- WorkIt offload({ timeout }) ----------------------------------------
{
  const clock = makeClock();
  const markerPath = path.join(os.tmpdir(), `workit-bench-07-workit-${process.pid}-${Date.now()}.marker`);
  if (existsSync(markerPath)) rmSync(markerPath);

  let rejectedAt = -1;
  let rejectionClass = null;

  const task = offload(spinnerURL, "spin", { durationMs: SPIN_MS, markerPath }, { timeout: `${TIMEOUT_MS}ms` });

  try {
    await run.scope(async (scope) => scope.spawn(task, { name: "spinner" }));
    rejectedAt = clock.t();
    rejectionClass = "fulfilled";
  } catch (err) {
    rejectedAt = clock.t();
    rejectionClass = err?.constructor?.name ?? "Unknown";
  }

  // Give the worker a generous grace window in case the OS termination is
  // racing the marker write. If hard-kill works, the marker still does not
  // appear because the host thread tore the worker down at TIMEOUT_MS.
  await new Promise((r) => setTimeout(r, 800));

  result.workit = {
    timeoutMs: TIMEOUT_MS,
    rejectedAt,
    rejectionClass,
    markerExistsAfterRejection: existsSync(markerPath),
    markerExistsAfterGrace: existsSync(markerPath),
  };
  if (existsSync(markerPath)) rmSync(markerPath);

  // Invariants
  assert.equal(rejectionClass, "TimeoutError", "offload must reject with TimeoutError when its timeout fires");
  assert.equal(result.workit.markerExistsAfterRejection, false, "late marker must NOT exist after offload timeout");
  assert.equal(result.workit.markerExistsAfterGrace, false, "late marker must NOT appear during grace window either");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
