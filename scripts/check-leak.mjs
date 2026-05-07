/**
 * Runtime leak smoke check for WorkJS scope disposal.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This is a fast CI-oriented guard, not a full memory benchmark. It repeatedly
 * opens and closes real scopes through the compiled package and fails when heap
 * growth exceeds a conservative bound after forced garbage collection.
 */

import { group } from "../dist/index.js";

const ITERATIONS = 2_000;
const MAX_HEAP_GROWTH_BYTES = 16 * 1024 * 1024;

if (typeof globalThis.gc !== "function") {
  console.error("Leak check requires Node to run with --expose-gc.");
  process.exit(1);
}

const forceGc = () => {
  for (let i = 0; i < 3; i++) globalThis.gc();
};

forceGc();
const before = process.memoryUsage().heapUsed;

for (let i = 0; i < ITERATIONS; i++) {
  await group(async (task) => {
    const value = await task(async (ctx) => {
      ctx.defer(() => undefined);
      ctx.report({ pct: 1 });
      return i;
    }, { name: "leak-smoke-task" });

    if (value !== i) {
      throw new Error(`Unexpected task value at iteration ${i}`);
    }
  }, { name: "leak-smoke-scope" });
}

forceGc();
const after = process.memoryUsage().heapUsed;
const growth = Math.max(0, after - before);

console.log(
  `leak-smoke: ${ITERATIONS} scopes, heap growth ${growth} B ` +
    `(limit ${MAX_HEAP_GROWTH_BYTES} B)`
);

if (growth > MAX_HEAP_GROWTH_BYTES) {
  console.error("Heap growth exceeded leak smoke limit.");
  process.exit(1);
}
