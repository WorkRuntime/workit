/**
 * Long-haul 24-hour runtime soak entrypoint.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This script intentionally is not part of the default verification chain. It
 * uses the same compiled-package contract as `check-soak.mjs` and runs until
 * the configured duration elapses.
 */

import { runRuntimeSoak } from "./soak-runtime.mjs";

const result = await runRuntimeSoak({
  taskCount: Number.parseInt(process.env.WORKIT_SOAK_TASKS ?? "100000", 10),
  concurrency: Number.parseInt(process.env.WORKIT_SOAK_CONCURRENCY ?? "128", 10),
  durationMs: Number.parseInt(process.env.WORKIT_SOAK_DURATION_MS ?? "86400000", 10),
  maxBatchDurationMs: Number.parseInt(process.env.WORKIT_SOAK_MAX_BATCH_MS ?? "120000", 10),
});

console.log(JSON.stringify({ runtimeSoak24h: "ok", ...result }));
