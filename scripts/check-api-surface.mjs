/**
 * Public API surface lock for the compiled WorkJS package.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This guard catches accidental runtime export changes before package users see
 * them. Type-only changes still require focused declaration review.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const EXPECTED_EXPORT_MAP = [
  ".",
  "./ai",
  "./diagnostics",
  "./observability",
  "./otel",
  "./worker",
];

const EXPECTED_RUNTIME_EXPORTS = {
  ".": [
    "BudgetExceededError",
    "CancellationError",
    "ContextBagImpl",
    "CostBudget",
    "LatencyBudget",
    "TelemetryBudget",
    "TimeoutError",
    "TokenBudget",
    "WorkAggregateError",
    "createBudget",
    "createContextKey",
    "getCurrentScope",
    "group",
    "renderTree",
    "run",
    "work",
  ],
  "./ai": [
    "BadBatchError",
    "OpenAITokens",
    "embedAll",
    "embedAllBisection",
    "streamWithBackpressure",
    "transcribeStream",
    "wrapAI",
  ],
  "./diagnostics": [
    "diagnoseSnapshot",
  ],
  "./observability": [
    "attachScopeSummaryExporter",
    "attachTelemetryExporter",
    "createCardinalitySafeMetricExporter",
  ],
  "./otel": [
    "attachOpenTelemetry",
  ],
  "./worker": [
    "offload",
  ],
};

const EXPECTED_EXPORT_CONDITIONS = {
  ".": ["default", "node", "types"],
  "./ai": ["default", "node", "types"],
  "./diagnostics": ["import", "require", "types"],
  "./observability": ["import", "require", "types"],
  "./otel": ["import", "require", "types"],
  "./worker": ["default", "node", "types"],
};

const MODULE_PATHS = {
  ".": "../dist/index.js",
  "./ai": "../dist/ai/index.js",
  "./diagnostics": "../dist/diagnostics/index.js",
  "./observability": "../dist/observability/index.js",
  "./otel": "../dist/otel/index.js",
  "./worker": "../dist/worker/index.js",
};

const CJS_MODULE_PATHS = {
  ".": "../dist-cjs/index.cjs",
  "./ai": "../dist-cjs/ai/index.cjs",
  "./diagnostics": "../dist-cjs/diagnostics/index.cjs",
  "./observability": "../dist-cjs/observability/index.cjs",
};

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

assert.deepEqual(
  Object.keys(packageJson.exports).sort(),
  EXPECTED_EXPORT_MAP,
  "package.json exports changed without updating the API surface lock"
);

for (const [subpath, expected] of Object.entries(EXPECTED_RUNTIME_EXPORTS)) {
  assert.deepEqual(
    Object.keys(packageJson.exports[subpath]).sort(),
    EXPECTED_EXPORT_CONDITIONS[subpath],
    `${subpath} package export conditions changed without updating the API surface lock`
  );

  const module = await import(MODULE_PATHS[subpath]);
  assert.deepEqual(
    Object.keys(module).sort(),
    expected,
    `${subpath} runtime exports changed without updating the API surface lock`
  );

  const cjsPath = CJS_MODULE_PATHS[subpath];
  if (cjsPath !== undefined) {
    const cjsModule = require(cjsPath);
    assert.deepEqual(
      Object.keys(cjsModule).sort(),
      expected,
      `${subpath} CommonJS exports changed without updating the API surface lock`
    );
  }
}

console.log(`api-surface: locked ${EXPECTED_EXPORT_MAP.length} package export paths`);
