/**
 * Shared runtime soak runner for WorkJS.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The soak exercises the compiled public package through real scopes and
 * bounded task pools. CI runs one 100k-task batch; the 24-hour entrypoint loops
 * the same contract for long-haul validation.
 */

import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { group, run } from "../dist/index.js";

const DEFAULT_MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BATCH_DURATION_MS = 120_000;

export async function runRuntimeSoak({
  taskCount = 100_000,
  concurrency = 128,
  durationMs = 0,
  maxHeapGrowthBytes = DEFAULT_MAX_HEAP_GROWTH_BYTES,
  maxBatchDurationMs = DEFAULT_MAX_BATCH_DURATION_MS,
} = {}) {
  if (typeof globalThis.gc !== "function") {
    throw new Error("Runtime soak requires Node to run with --expose-gc.");
  }
  if (!Number.isInteger(taskCount) || taskCount < 1) throw new Error("taskCount must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const startedAt = performance.now();
  let batches = 0;
  let logicalTasks = 0;
  let maxActive = 0;
  let maxHeapGrowth = 0;
  let maxBatchDuration = 0;

  try {
    do {
      const batch = await runSoakBatch(taskCount, concurrency, maxHeapGrowthBytes);
      batches++;
      logicalTasks += taskCount;
      maxActive = Math.max(maxActive, batch.maxActive);
      maxHeapGrowth = Math.max(maxHeapGrowth, batch.heapGrowth);
      maxBatchDuration = Math.max(maxBatchDuration, batch.durationMs);

      if (batch.durationMs > maxBatchDurationMs) {
        throw new Error(`Soak batch took ${Math.round(batch.durationMs)} ms, limit ${maxBatchDurationMs} ms`);
      }
      if (unhandled.length > 0) {
        throw new Error(`Unhandled rejection during soak: ${String(unhandled[0])}`);
      }
    } while (durationMs > 0 && performance.now() - startedAt < durationMs);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  return {
    batches,
    logicalTasks,
    concurrency,
    maxActive,
    maxHeapGrowth,
    maxBatchDurationMs: Math.round(maxBatchDuration),
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function runSoakBatch(taskCount, concurrency, maxHeapGrowthBytes) {
  await delay(0);
  forceGc();
  const before = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const { checksum, maxActive } = await executeSoakBatch(taskCount, concurrency);

  const expectedChecksum = taskCount * (taskCount - 1) / 2;
  if (checksum !== expectedChecksum) {
    throw new Error(`Soak checksum ${checksum} did not match ${expectedChecksum}`);
  }
  if (maxActive > concurrency) {
    throw new Error(`Soak max concurrency ${maxActive} exceeded ${concurrency}`);
  }

  forceGc();
  const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - before);
  if (heapGrowth > maxHeapGrowthBytes) {
    throw new Error(`Soak heap growth ${heapGrowth} B exceeded ${maxHeapGrowthBytes} B`);
  }

  return {
    maxActive,
    heapGrowth,
    durationMs: performance.now() - startedAt,
  };
}

async function executeSoakBatch(taskCount, concurrency) {
  let active = 0;
  let maxActive = 0;

  const checksum = await group(async () => {
    const tasks = Array.from({ length: taskCount }, (_, index) => async (ctx) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (index % 1_000 === 0) ctx.report({ pct: index / taskCount });
      await Promise.resolve();
      active--;
      return index;
    });

    const values = await run.pool(concurrency, tasks);
    return values.reduce((sum, value) => sum + value, 0);
  }, { name: "runtime-soak" });

  return { checksum, maxActive };
}

function forceGc() {
  for (let i = 0; i < 3; i++) globalThis.gc();
}
