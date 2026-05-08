/**
 * Bench 16 -- sampling reduction in exported event volume.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: 100 root scopes. Each spawns 5 child tasks. 95% of scopes
 * complete fast and successfully; 5% are slow (>= slowThresholdMs); a small
 * fraction of the rest fail.
 *
 * We compare two sampling policies attached via `attachTelemetryExporter`:
 *
 *   `mode: "all"`             -- every TaskEvent reaches the exporter (raw firehose)
 *   `mode: "errors_and_slow"` -- only the errored or slow traces reach the exporter
 *
 * The article's claim is a 20x reduction at 5% slow/errored. We assert
 * at least 5x to keep the bench tolerant to platform jitter; in practice
 * the measured factor is significantly higher.
 *
 * The "200 tasks -> 1 summary record" claim from the article is a separate
 * proof -- it lives in the production gate `npm run check:exporter-stress`
 * because `attachScopeSummaryExporter` requires the `scope:opened` event,
 * which fires before user code can attach inside `run.scope`.
 */

import assert from "node:assert/strict";
import { run } from "../../dist/index.js";
import { attachTelemetryExporter } from "../../dist/observability/index.js";
import { sleep, jsonReplacer } from "./lib/baselines.mjs";

const ROOTS = 100;
const TASKS_PER_ROOT = 5;
const SLOW_RATE = 0.05;
const ERROR_RATE = 0.02;
const SLOW_MS = 60;
const FAST_MS = 5;

async function workload(scope, slow, willFail) {
  const handles = [];
  for (let i = 0; i < TASKS_PER_ROOT; i++) {
    handles.push(scope.spawn(async (ctx) => {
      await sleep(slow ? SLOW_MS : FAST_MS, ctx.signal);
      if (willFail && i === TASKS_PER_ROOT - 1) throw new Error("synthetic-fail");
      return i;
    }, { name: `child-${i}`, kind: "io" }));
  }
  await Promise.allSettled(handles);
  if (willFail) throw new Error("root-fail");
}

async function runMany(sampling) {
  const taskEvents = [];

  const completions = [];
  for (let i = 0; i < ROOTS; i++) {
    const slow = i < ROOTS * SLOW_RATE;
    const willFail = !slow && i < ROOTS * (SLOW_RATE + ERROR_RATE);
    completions.push((async () => {
      try {
        await run.scope(async (scope) => {
          attachTelemetryExporter(scope, (e) => { taskEvents.push(e); }, { sampling });
          await workload(scope, slow, willFail);
        });
      } catch { /* expected for the willFail traces */ }
    })());
  }
  await Promise.all(completions);
  return { taskEvents: taskEvents.length };
}

const result = { bench: "16-sampling-and-aggregation" };

result.unsampled_per_task         = await runMany({ mode: "all" });
result.errors_and_slow_per_task   = await runMany({ mode: "errors_and_slow", slowThresholdMs: SLOW_MS - 5 });

result.reduction_factor = +(
  result.unsampled_per_task.taskEvents / Math.max(1, result.errors_and_slow_per_task.taskEvents)
).toFixed(2);

result.workload = {
  rootScopes: ROOTS,
  tasksPerRoot: TASKS_PER_ROOT,
  slowRate: SLOW_RATE,
  errorRate: ERROR_RATE,
  slowMs: SLOW_MS,
};

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");

// Invariants
assert.ok(
  result.errors_and_slow_per_task.taskEvents < result.unsampled_per_task.taskEvents / 5,
  `errors_and_slow must reduce task-event volume at least 5x (got ${result.reduction_factor}x)`,
);
