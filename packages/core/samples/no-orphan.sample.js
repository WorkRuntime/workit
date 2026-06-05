/**
 * No-orphan background sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shows that scoped background work is still owned: the group does not finish
 * until the background task settles.
 */

import assert from "node:assert/strict";
import { group } from "../dist/index.js";

let backgroundCompleted = false;
const startedAt = Date.now();

const result = await group(async (task) => {
  task.background(async (ctx) => {
    await sleep(20, ctx.signal);
    backgroundCompleted = true;
  });
  return "body-returned";
});

const elapsedMs = Date.now() - startedAt;

assert.equal(result, "body-returned");
assert.equal(backgroundCompleted, true);
assert.ok(elapsedMs >= 15);

process.stdout.write(`${JSON.stringify({
  sample: "no-orphan",
  result,
  backgroundCompleted,
  elapsedMs,
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
