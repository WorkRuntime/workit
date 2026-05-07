/**
 * Resilient batch upload sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Demonstrates bounded concurrency, retry, timeout, and continuing error
 * collection for a batch workload.
 */

import assert from "node:assert/strict";
import { work } from "../dist/index.js";

const attempts = new Map();
let active = 0;
let maxActive = 0;

const output = await work(["a.txt", "flaky.txt", "bad.txt", "b.txt", "c.txt"])
  .inParallel(3)
  .withRetry({ times: 2, initialDelay: 1, maxDelay: 1, jitter: false })
  .withTimeout("200ms")
  .onError("continue")
  .do(async (file, ctx) => {
    active++;
    maxActive = Math.max(maxActive, active);
    const nextAttempt = (attempts.get(file) ?? 0) + 1;
    attempts.set(file, nextAttempt);
    await sleep(2, ctx.signal);
    active--;

    if (file === "flaky.txt" && nextAttempt === 1) throw new Error("transient upload failure");
    if (file === "bad.txt") throw new Error("unsupported file");
    return `uploaded:${file}`;
  });

assert.equal(output.mode, "continue");
assert.deepEqual(output.results.sort(), ["uploaded:a.txt", "uploaded:b.txt", "uploaded:c.txt", "uploaded:flaky.txt"]);
assert.equal(output.errors.length, 1);
assert.equal(attempts.get("flaky.txt"), 2);
assert.ok(maxActive <= 3);

process.stdout.write(`${JSON.stringify({
  sample: "batch-upload",
  mode: output.mode,
  uploaded: output.results.length,
  errors: output.errors.map((item) => String(item.item)),
  flakyAttempts: attempts.get("flaky.txt"),
  maxActive,
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
