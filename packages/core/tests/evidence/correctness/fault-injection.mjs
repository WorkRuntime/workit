/**
 * Correctness evidence: bounded fault injection through real WorkIt scopes.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createSuite } from "../harness.mjs";
import {
  cancellationStorm,
  cleanupHang,
  providerTimeout,
  retryExhaustion,
  runFaultSuite,
} from "../../../dist/fault/index.js";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-011",
  "fault injection harness records lifecycle evidence through real scopes",
  "bounded cancellation, cleanup timeout, provider timeout, and retry exhaustion scenarios return passing reports with WorkIt receipts",
  async () => {
    const report = await runFaultSuite([
      cancellationStorm({ taskCount: 2, cancelAfter: 1, workerDuration: 50 }),
      cleanupHang({ cleanupTimeout: 5 }),
      providerTimeout({ timeout: 5, providerLatency: 50 }),
      retryExhaustion({ attempts: 3, initialDelay: 1 }),
    ]);
    const cleanup = report.reports.find((item) => item.scenario.kind === "cleanup_hang");
    const retry = report.reports.find((item) => item.scenario.kind === "retry_exhaustion");
    const timeout = report.reports.find((item) => item.scenario.kind === "provider_timeout");

    return {
      ok: report.failed === 0
        && cleanup?.receipt.summary.cleanupTimeouts === 1
        && retry?.receipt.events.filter((event) => event.type === "task:retrying").length === 2
        && timeout?.receipt.events.some((event) => event.type === "task:failed" && event.error?.name === "TimeoutError") === true,
      passed: report.passed,
      failed: report.failed,
      scenarios: report.reports.map((item) => ({
        id: item.scenario.id,
        kind: item.scenario.kind,
        status: item.status,
        outcome: item.receipt.terminal.outcome,
        findings: item.findings.map((finding) => finding.code),
      })),
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
