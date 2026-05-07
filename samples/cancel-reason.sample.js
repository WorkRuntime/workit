/**
 * Cancellation reason sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shows how a scope-level cancellation reason is observed both by the scope and
 * by the task receiving the aborted signal.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../dist/index.js";

let scopeReason;
let taskReason;

await run.scope(async (scope) => {
  scope.onCancel((reason) => {
    scopeReason = reason;
  });

  const handle = scope.spawn(async (ctx) => {
    try {
      await sleep(1_000, ctx.signal);
      return "late";
    } catch (err) {
      if (err instanceof CancellationError) taskReason = err.reason;
      throw err;
    }
  }, { name: "provider.call", kind: "llm" });

  scope.cancel({ kind: "manual", tag: "user_stopped_request" });
  await assert.rejects(handle, CancellationError);
}, { name: "cancel.reason" });

assert.deepEqual(scopeReason, { kind: "manual", tag: "user_stopped_request" });
assert.deepEqual(taskReason, scopeReason);

process.stdout.write(`${JSON.stringify({
  sample: "cancel-reason",
  scopeReason,
  taskReason,
})}\n`);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
