/**
 * Timeout cancellation sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Proves timeout wrappers actually abort signal-aware work, not just reject
 * while the original operation keeps running.
 */

import assert from "node:assert/strict";
import { CancellationError, TimeoutError, group, run } from "../dist/index.js";

let stopped = false;
let reasonKind;

await assert.rejects(
  group(async (task) => task(run.timeout(async (ctx) => {
    try {
      await sleep(1_000, ctx.signal);
      return "late";
    } catch (err) {
      stopped = true;
      if (err instanceof CancellationError) reasonKind = err.reason.kind;
      throw err;
    }
  }, "10ms"), { name: "timeout.provider" })),
  TimeoutError
);

assert.equal(stopped, true);
assert.equal(reasonKind, "timeout");

process.stdout.write(`${JSON.stringify({
  sample: "timeout-stop",
  stopped,
  reasonKind,
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
