/**
 * Explicit worker-thread offload sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Proves CPU-heavy work can opt into worker-thread execution without automatic
 * routing, RxJS operators, or runtime dependencies.
 */

import assert from "node:assert/strict";
import { run } from "../dist/index.js";
import { offload } from "../dist/worker/index.js";

const moduleURL = new URL("./cpu-worker.sample-worker.js", import.meta.url);

const results = await run.pool(2, [
  offload(moduleURL, "fibonacci", 20),
  offload(moduleURL, "fibonacci", 21),
]);

assert.deepEqual(results.map((item) => item.value), [6_765, 10_946]);
assert.ok(results.every((item) => item.threadId > 0));

process.stdout.write(`${JSON.stringify({
  sample: "worker-offload",
  values: results.map((item) => item.value),
  workerThreadIds: results.map((item) => item.threadId),
})}\n`);
