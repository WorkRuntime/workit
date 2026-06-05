/**
 * Safer Promise.all sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Demonstrates `run.all`: first failure cancels sibling work and cleanup still
 * runs for the cancelled sibling.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../dist/index.js";

let slowCancelled = false;
const cleanups = [];

await assert.rejects(
  run.all([
    async () => "fast",
    async () => {
      await sleep(5);
      throw new Error("provider failed");
    },
    async (ctx) => {
      ctx.defer(() => cleanups.push("slow-cleanup"));
      try {
        await sleep(1_000, ctx.signal);
        return "slow";
      } catch (err) {
        slowCancelled = err instanceof CancellationError
          && err.reason.kind === "sibling_failed";
        throw err;
      }
    },
  ]),
  /provider failed/
);

assert.equal(slowCancelled, true);
assert.deepEqual(cleanups, ["slow-cleanup"]);

process.stdout.write(`${JSON.stringify({
  sample: "safer-promise-all",
  slowCancelled,
  cleanupRan: cleanups.includes("slow-cleanup"),
})}\n`);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
