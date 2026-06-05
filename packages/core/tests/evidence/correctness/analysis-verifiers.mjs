/**
 * Correctness evidence: analysis verifiers over lifecycle receipts.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { analyzeReceipt, verifyReceipt } from "../../../dist/analysis/index.js";
import { buildReceipt } from "../../../dist/replay/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-007",
  "receipt analysis detects leaked owned work",
  "a non-terminal receipt with pending tasks fails analysis with leaked_tasks",
  async () => {
    const receipt = buildReceipt([], {
      id: "scope-analysis",
      status: "running",
      startedAt: 1,
      pendingCount: 1,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      tasks: [
        {
          id: "task-analysis",
          name: "pending",
          kind: "custom",
          status: "running",
          attempt: 1,
          startedAt: 1,
        },
      ],
      scopes: [],
    }, {
      clock: () => 2,
      receiptId: "receipt-analysis",
    });
    const report = analyzeReceipt(receipt);

    return {
      ok: report.status === "fail"
        && report.findings.some((finding) => finding.code === "leaked_tasks"),
      status: report.status,
      findings: report.findings.map((finding) => finding.code),
    };
  },
);

await suite.proof(
  "CORR-013",
  "receipt verifier proves declared lifecycle evidence",
  "a closed receipt with terminal and cleanup evidence verifies no orphaned owned tasks while preserving cleanup timeout warning evidence",
  async () => {
    const receipt = buildReceipt([
      { type: "task:cleanup_timeout", taskId: "task-cleanup", timeoutMs: 5, at: 2 },
      { type: "scope:closing", scopeId: "scope-verify", reason: "completed", at: 3 },
      { type: "scope:closed", scopeId: "scope-verify", durationMs: 4, at: 4 },
    ], {
      id: "scope-verify",
      status: "closed",
      startedAt: 1,
      pendingCount: 0,
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      tasks: [
        {
          id: "task-cleanup",
          name: "cleanup",
          kind: "custom",
          status: "succeeded",
          attempt: 1,
          startedAt: 1,
          durationMs: 1,
        },
      ],
      scopes: [],
    }, {
      receiptId: "receipt-verify",
    });
    const report = verifyReceipt(receipt, {
      requireCleanupEvidence: true,
      requireTerminalEvent: true,
    });
    const checks = new Map(report.checks.map((check) => [check.code, check.status]));

    return {
      ok: report.findings.every((finding) => finding.severity !== "error")
        && checks.get("no_orphaned_owned_tasks") === "pass"
        && checks.get("cleanup_evidence_recorded") === "pass"
        && checks.get("terminal_event_recorded") === "pass"
        && checks.get("terminal_cause_recorded") === "pass",
      status: report.status,
      checks: Object.fromEntries(checks),
      findings: report.findings.map((finding) => finding.code),
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
