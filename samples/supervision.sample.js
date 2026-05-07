/**
 * Background supervision sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shows supervised background-style work restarting transient failures under an
 * explicit restart policy.
 */

import assert from "node:assert/strict";
import { run } from "../dist/index.js";

let attempts = 0;

const result = await run.supervise(async () => {
  attempts++;
  if (attempts < 3) throw new Error("transient worker failure");
  return "stable";
}, {
  restartOn: "error",
  maxRestarts: 3,
  backoff: () => 1,
});

assert.equal(result, "stable");
assert.equal(attempts, 3);

process.stdout.write(`${JSON.stringify({
  sample: "supervision",
  result,
  attempts,
})}\n`);
