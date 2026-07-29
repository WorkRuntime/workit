/**
 * Public API surface lock for the compiled WorkIt package.
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
  "./activity",
  "./ai",
  "./analysis",
  "./channel",
  "./contracts",
  "./diagnostics",
  "./fault",
  "./ledger",
  "./observability",
  "./otel",
  "./replay",
  "./resources",
  "./time-policy",
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
  "./activity": [
    "ActivityConflictError",
    "ActivityNotRunnableError",
    "ActivitySerializationError",
    "createFileActivityStore",
    "createMemoryActivityStore",
    "runActivity",
  ],
  "./ai": [
    "AgentCapabilityError",
    "AgentToolCalls",
    "BadBatchError",
    "OpenAITokens",
    "embedAll",
    "embedAllBisection",
    "runAgent",
    "streamLLM",
    "streamWithBackpressure",
    "transcribeStream",
    "wrapAI",
  ],
  "./analysis": [
    "analyzeReceipt",
    "verifyReceipt",
    "verifyScopeProtocol",
    "verifySourceProtocol",
    "verifyTimePolicy",
  ],
  "./channel": [
    "ChannelClosedError",
    "createChannel",
  ],
  "./contracts": [
    "cancellable",
    "discardCancellation",
    "getTaskContract",
    "isCancellableTask",
    "isShieldedTask",
    "shielded",
    "typedGroup",
  ],
  "./diagnostics": [
    "diagnoseSnapshot",
  ],
  "./fault": [
    "cancellationStorm",
    "cleanupHang",
    "providerTimeout",
    "retryExhaustion",
    "runFaultScenario",
    "runFaultSuite",
  ],
  "./ledger": [
    "ReceiptLedgerConflictError",
    "createFileReceiptLedger",
    "createMemoryReceiptLedger",
    "createPostgresReceiptLedger",
    "createSqliteReceiptLedger",
  ],
  "./observability": [
    "attachScopeSummaryExporter",
    "attachTelemetryExporter",
    "createCardinalitySafeMetricExporter",
  ],
  "./otel": [
    "attachOpenTelemetry",
  ],
  "./replay": [
    "buildReceipt",
    "createAttemptRecorder",
    "createReceiptRecorder",
    "redactReceipt",
  ],
  "./resources": [
    "bracketLazy",
    "bracketShared",
    "scopeAcquire",
  ],
  "./time-policy": [
    "estimateHedge",
    "estimateRetry",
    "planTimePolicy",
  ],
  "./worker": [
    "offload",
  ],
};

const EXPECTED_EXPORT_CONDITIONS = {
  ".": ["default", "node", "types"],
  "./activity": ["default", "node", "types"],
  "./ai": ["default", "node", "types"],
  "./analysis": ["import", "require", "types"],
  "./channel": ["import", "require", "types"],
  "./contracts": ["import", "require", "types"],
  "./diagnostics": ["import", "require", "types"],
  "./fault": ["default", "node", "types"],
  "./ledger": ["default", "node", "types"],
  "./observability": ["import", "require", "types"],
  "./otel": ["import", "require", "types"],
  "./replay": ["import", "require", "types"],
  "./resources": ["import", "require", "types"],
  "./time-policy": ["import", "require", "types"],
  "./worker": ["default", "node", "types"],
};

const MODULE_PATHS = {
  ".": "../dist/index.js",
  "./activity": "../dist/activity/index.js",
  "./ai": "../dist/ai/index.js",
  "./analysis": "../dist/analysis/index.js",
  "./channel": "../dist/channel/index.js",
  "./contracts": "../dist/contracts/index.js",
  "./diagnostics": "../dist/diagnostics/index.js",
  "./fault": "../dist/fault/index.js",
  "./ledger": "../dist/ledger/index.js",
  "./observability": "../dist/observability/index.js",
  "./otel": "../dist/otel/index.js",
  "./replay": "../dist/replay/index.js",
  "./resources": "../dist/resources/index.js",
  "./time-policy": "../dist/time-policy/index.js",
  "./worker": "../dist/worker/index.js",
};

const CJS_MODULE_PATHS = {
  ".": "../dist-cjs/index.cjs",
  "./activity": "../dist-cjs/activity/index.cjs",
  "./ai": "../dist-cjs/ai/index.cjs",
  "./analysis": "../dist-cjs/analysis/index.cjs",
  "./channel": "../dist-cjs/channel/index.cjs",
  "./contracts": "../dist-cjs/contracts/index.cjs",
  "./diagnostics": "../dist-cjs/diagnostics/index.cjs",
  "./fault": "../dist-cjs/fault/index.cjs",
  "./ledger": "../dist-cjs/ledger/index.cjs",
  "./observability": "../dist-cjs/observability/index.cjs",
  "./replay": "../dist-cjs/replay/index.cjs",
  "./resources": "../dist-cjs/resources/index.cjs",
  "./time-policy": "../dist-cjs/time-policy/index.cjs",
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
