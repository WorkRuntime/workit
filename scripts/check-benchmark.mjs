/**
 * Runtime benchmark smoke check for WorkJS.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This gate measures the compiled artifact with conservative thresholds. It is
 * designed to catch obvious performance regressions in CI, not to replace the
 * full reproducible benchmark suite needed for release claims.
 */

import { performance } from "node:perf_hooks";
import { group, run } from "../dist/index.js";

const BENCHMARKS = [
  {
    name: "group-one-task",
    iterations: 2_000,
    minOpsPerSecond: 5_000,
    fn: () => group(async (task) => task(async () => 1)),
  },
  {
    name: "run-all-32",
    iterations: 500,
    minOpsPerSecond: 500,
    fn: () => run.all(Array.from({ length: 32 }, () => async () => 1)),
  },
];

async function measure(benchmark) {
  for (let i = 0; i < 50; i++) await benchmark.fn();

  const startedAt = performance.now();
  for (let i = 0; i < benchmark.iterations; i++) await benchmark.fn();
  const durationMs = performance.now() - startedAt;
  const opsPerSecond = benchmark.iterations / (durationMs / 1000);

  return {
    name: benchmark.name,
    durationMs,
    opsPerSecond,
    minOpsPerSecond: benchmark.minOpsPerSecond,
  };
}

const failures = [];

for (const benchmark of BENCHMARKS) {
  const result = await measure(benchmark);
  console.log(
    `${result.name}: ${Math.round(result.opsPerSecond)} ops/sec ` +
      `(minimum ${result.minOpsPerSecond})`
  );

  if (result.opsPerSecond < result.minOpsPerSecond) {
    failures.push(
      `${result.name} below minimum: ${Math.round(result.opsPerSecond)} < ${result.minOpsPerSecond}`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
