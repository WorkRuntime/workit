/**
 * CI-safe 100k-task runtime soak gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { runRuntimeSoak } from "./soak-runtime.mjs";

const result = await runRuntimeSoak({
  taskCount: Number.parseInt(process.env.WORKJS_SOAK_TASKS ?? "100000", 10),
  concurrency: Number.parseInt(process.env.WORKJS_SOAK_CONCURRENCY ?? "128", 10),
  ...(process.env.WORKJS_SOAK_MAX_HEAP_MB !== undefined
    ? { maxHeapGrowthBytes: Number.parseInt(process.env.WORKJS_SOAK_MAX_HEAP_MB, 10) * 1024 * 1024 }
    : {}),
});

console.log(JSON.stringify({ runtimeSoak: "ok", ...result }));
