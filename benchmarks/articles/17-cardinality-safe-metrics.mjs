/**
 * Bench 17 -- cardinality-safe metric exporter.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: emit a small batch of metric points through the cardinality-safe
 * wrapper. Some points use bounded labels (`task.kind` enum, `outcome` enum).
 * Others try to smuggle unbounded labels (`task.id` UUIDs, free-form
 * `error.message`).
 *
 * The wrapper must:
 *   - accept bounded labels when they appear in the allowedLabels list
 *   - reject (or strip) unbounded labels not in the allowed list
 */

import assert from "node:assert/strict";
import { createCardinalitySafeMetricExporter } from "../../dist/observability/index.js";
import { jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "17-cardinality-safe-metrics", emitted: [], rejected: [] };

const allowedLabels = ["task.kind", "outcome", "scope.name"];

const safeExporter = createCardinalitySafeMetricExporter(
  (point) => { result.emitted.push(point); },
  { allowedLabels },
);

const candidates = [
  { name: "task.duration", value: 12, labels: { "task.kind": "io",  "outcome": "succeeded" } },
  { name: "task.duration", value: 35, labels: { "task.kind": "llm", "outcome": "failed" } },
  // Unbounded label task.id - must be rejected or stripped.
  { name: "task.duration", value: 99, labels: { "task.kind": "tool", "task.id": "uuid-abc" } },
  // Free-form text in label value.
  { name: "task.duration", value: 17, labels: { "task.kind": "io",  "error.message": "EHOSTUNREACH at 10.0.0.42 retrying" } },
  // Out-of-enum value for a bounded label.
  { name: "task.duration", value: 21, labels: { "task.kind": "evil" } },
];

for (const candidate of candidates) {
  try {
    await safeExporter(candidate);
  } catch (err) {
    result.rejected.push({
      name: candidate.name,
      labels: candidate.labels,
      errorClass: err?.constructor?.name ?? "Unknown",
      errorMessage: err?.message ?? null,
    });
  }
}

result.summary = {
  emittedCount: result.emitted.length,
  rejectedCount: result.rejected.length,
  emittedKinds: result.emitted.map((p) => p.labels?.["task.kind"]).filter(Boolean),
};

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");

// Invariants
assert.ok(result.rejected.length >= 1, "at least one unbounded-label point must be rejected or stripped");
assert.ok(
  result.emitted.every((p) => Object.keys(p.labels ?? {}).every((k) => allowedLabels.includes(k))),
  "every emitted metric must only carry allowed labels",
);
