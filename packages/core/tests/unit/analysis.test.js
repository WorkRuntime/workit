/**
 * Analysis subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  analyzeReceipt,
  verifyReceipt,
  verifyScopeProtocol,
  verifySourceProtocol,
  verifyTimePolicy,
} from "../../dist/analysis/index.js";
import { buildReceipt } from "../../dist/replay/index.js";

test("Given receipt with leaked tasks, analyzeReceipt reports lifecycle finding", () => {
  const receipt = buildReceipt([], {
    id: "scope-leak",
    status: "running",
    startedAt: 1,
    pendingCount: 1,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [
      {
        id: "task-leak",
        name: "leaked",
        kind: "custom",
        status: "running",
        attempt: 1,
        startedAt: 1,
      },
    ],
    scopes: [],
  }, {
    clock: () => 2,
    receiptId: "receipt-leak",
  });

  const report = analyzeReceipt(receipt);

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "leaked_tasks"), true);
  assert.equal(report.findings.some((finding) => finding.code === "receipt_not_terminal"), true);
});

test("Given receipt with cleanup timeout and truncated events, analyzeReceipt returns warning status", () => {
  const receipt = buildReceipt([
    { type: "task:cleanup_timeout", taskId: "task-cleanup", timeoutMs: 5, at: 1 },
  ], {
    id: "scope-warn",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-warn",
    clock: () => 2,
  });
  const truncated = {
    ...receipt,
    summary: { ...receipt.summary, droppedEvents: 1 },
  };

  const report = analyzeReceipt(truncated);

  assert.equal(report.status, "warn");
  assert.equal(report.findings.some((finding) => finding.code === "cleanup_timeout"), true);
  assert.equal(report.findings.some((finding) => finding.code === "receipt_truncated"), true);
});

test("Given failed receipt, analyzeReceipt reports terminal failure", () => {
  const receipt = buildReceipt([
    { type: "scope:closing", scopeId: "scope-failed", reason: "errored", at: 1 },
  ], {
    id: "scope-failed",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 1,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-failed",
  });

  const report = analyzeReceipt(receipt);

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "terminal_failed"), true);
  assert.equal(report.findings.some((finding) => finding.code === "terminal_cause_missing"), true);
});

test("Given closed receipt with terminal event evidence, verifyReceipt passes explicit checks", () => {
  const receipt = buildReceipt([
    { type: "scope:closing", scopeId: "scope-ok", reason: "completed", at: 2 },
    { type: "scope:closed", scopeId: "scope-ok", durationMs: 3, at: 3 },
  ], {
    id: "scope-ok",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [
      {
        id: "task-ok",
        name: "ok",
        kind: "custom",
        status: "succeeded",
        attempt: 1,
        startedAt: 1,
        durationMs: 1,
      },
    ],
    scopes: [],
  }, {
    receiptId: "receipt-ok",
  });

  const report = verifyReceipt(receipt, { requireTerminalEvent: true });

  assert.equal(report.status, "pass");
  assert.equal(report.receiptId, "receipt-ok");
  assert.equal(report.checks.every((check) => check.status === "pass"), true);
});

test("Given pending nested task, verifyReceipt reports the orphaned task id", () => {
  const receipt = buildReceipt([
    { type: "scope:closing", scopeId: "scope-root", reason: "completed", at: 2 },
    { type: "scope:closed", scopeId: "scope-root", durationMs: 3, at: 3 },
  ], {
    id: "scope-root",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [
      {
        id: "scope-child",
        status: "running",
        startedAt: 1,
        pendingCount: 1,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        tasks: [
          {
            id: "task-nested",
            name: "nested",
            kind: "custom",
            status: "running",
            attempt: 1,
            startedAt: 1,
          },
        ],
        scopes: [],
      },
    ],
  }, {
    receiptId: "receipt-nested",
  });

  const report = verifyReceipt(receipt);
  const leaked = report.findings.find((finding) => finding.code === "leaked_tasks");

  assert.equal(report.status, "fail");
  assert.equal(leaked?.taskId, "task-nested");
  assert.equal(report.checks.find((check) => check.code === "no_orphaned_owned_tasks")?.status, "fail");
});

test("Given summary-only leaked task evidence, verifyReceipt reports leak without inventing a task id", () => {
  const receipt = buildReceipt([
    { type: "scope:closing", scopeId: "scope-summary-leak", reason: "completed", at: 2 },
    { type: "scope:closed", scopeId: "scope-summary-leak", durationMs: 3, at: 3 },
  ], {
    id: "scope-summary-leak",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-summary-leak",
  });
  const withSummaryLeak = {
    ...receipt,
    summary: { ...receipt.summary, leakedTasks: 1 },
  };

  const report = verifyReceipt(withSummaryLeak);
  const leaked = report.findings.find((finding) => finding.code === "leaked_tasks");

  assert.equal(report.status, "fail");
  assert.equal(leaked?.taskId, undefined);
  assert.equal(report.checks.find((check) => check.code === "no_orphaned_owned_tasks")?.count, 1);
});

test("Given cancelled receipt without typed cause, verifyReceipt reports missing terminal cause", () => {
  const receipt = buildReceipt([
    { type: "scope:closing", scopeId: "scope-cancelled", reason: "cancelled", at: 2 },
    { type: "scope:closed", scopeId: "scope-cancelled", durationMs: 3, at: 3 },
  ], {
    id: "scope-cancelled",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-cancelled-missing-cause",
  });

  const report = verifyReceipt(receipt);

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "terminal_cause_missing"), true);
  assert.equal(report.checks.find((check) => check.code === "terminal_cause_recorded")?.status, "fail");
});

test("Given failed and cancelled receipts with cause evidence, verifyReceipt passes terminal cause check", () => {
  const failed = buildReceipt([
    { type: "task:failed", taskId: "task-failed", error: new Error("provider failed"), durationMs: 1, at: 2 },
    { type: "scope:closing", scopeId: "scope-failed-with-cause", reason: "errored", at: 3 },
    { type: "scope:closed", scopeId: "scope-failed-with-cause", durationMs: 4, at: 4 },
  ], {
    id: "scope-failed-with-cause",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 1,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-failed-with-cause",
  });
  const cancelled = buildReceipt([
    {
      type: "task:cancelled",
      taskId: "task-cancelled",
      reason: { kind: "manual", tag: "manual_stop" },
      durationMs: 1,
      at: 2,
    },
    { type: "scope:closing", scopeId: "scope-cancelled-with-cause", reason: "cancelled", at: 3 },
    { type: "scope:closed", scopeId: "scope-cancelled-with-cause", durationMs: 4, at: 4 },
  ], {
    id: "scope-cancelled-with-cause",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 1,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-cancelled-with-cause",
  });

  const failedReport = verifyReceipt(failed);
  const cancelledReport = verifyReceipt(cancelled);

  assert.equal(failedReport.findings.some((finding) => finding.code === "terminal_cause_missing"), false);
  assert.equal(failedReport.checks.find((check) => check.code === "terminal_cause_recorded")?.status, "pass");
  assert.equal(cancelledReport.status, "pass");
  assert.equal(cancelledReport.checks.find((check) => check.code === "terminal_cause_recorded")?.status, "pass");
});

test("Given cleanup evidence is required, verifyReceipt distinguishes absent and observed evidence", () => {
  const snapshot = {
    id: "scope-cleanup-required",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  };
  const withoutCleanup = buildReceipt([
    { type: "scope:closing", scopeId: "scope-cleanup-required", reason: "completed", at: 2 },
    { type: "scope:closed", scopeId: "scope-cleanup-required", durationMs: 3, at: 3 },
  ], snapshot, {
    receiptId: "receipt-cleanup-missing",
  });
  const withCleanup = buildReceipt([
    { type: "task:cleanup_timeout", taskId: "task-cleanup", timeoutMs: 5, at: 2 },
    { type: "scope:closing", scopeId: "scope-cleanup-required", reason: "completed", at: 3 },
    { type: "scope:closed", scopeId: "scope-cleanup-required", durationMs: 4, at: 4 },
  ], snapshot, {
    receiptId: "receipt-cleanup-observed",
  });

  const missing = verifyReceipt(withoutCleanup, { requireCleanupEvidence: true });
  const observed = verifyReceipt(withCleanup, { requireCleanupEvidence: true });

  assert.equal(missing.status, "fail");
  assert.equal(missing.findings.some((finding) => finding.code === "cleanup_evidence_missing"), true);
  assert.equal(observed.status, "warn");
  assert.equal(observed.findings.some((finding) => finding.code === "cleanup_evidence_missing"), false);
  assert.equal(observed.findings.some((finding) => finding.code === "cleanup_timeout"), true);
  assert.equal(observed.checks.find((check) => check.code === "cleanup_evidence_recorded")?.status, "pass");
});

test("Given terminal event is required, verifyReceipt reports missing root terminal event", () => {
  const receipt = buildReceipt([], {
    id: "scope-no-terminal-event",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-no-terminal-event",
  });

  const report = verifyReceipt(receipt, { requireTerminalEvent: true });

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "terminal_event_missing"), true);
  assert.equal(report.checks.find((check) => check.code === "terminal_event_recorded")?.status, "fail");
});

test("Given terminal timestamp without root event, verifyReceipt accepts timestamp evidence", () => {
  const receipt = buildReceipt([], {
    id: "scope-terminal-at",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-terminal-at",
  });
  const withTerminalTimestamp = {
    ...receipt,
    terminal: { ...receipt.terminal, at: 3 },
  };

  const report = verifyReceipt(withTerminalTimestamp, { requireTerminalEvent: true });

  assert.equal(report.status, "pass");
  assert.equal(report.checks.find((check) => check.code === "terminal_event_recorded")?.status, "pass");
});

test("Given non-terminal root-scoped events, verifyReceipt does not treat them as terminal evidence", () => {
  const receipt = buildReceipt([
    { type: "task:started", taskId: "task-not-terminal", scopeId: "scope-task-only", name: "work", kind: "custom", at: 2 },
    { type: "scope:opened", scopeId: "scope-child-only", parentId: "scope-task-only", at: 3 },
  ], {
    id: "scope-task-only",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-task-only",
  });

  const report = verifyReceipt(receipt, { requireTerminalEvent: true });

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "terminal_event_missing"), true);
});

test("Given task event after terminal event, verifyScopeProtocol reports protocol violation", () => {
  const report = verifyScopeProtocol([
    { type: "task:started", taskId: "task-a", scopeId: "scope-a", name: "a", kind: "custom", at: 1 },
    { type: "task:succeeded", taskId: "task-a", durationMs: 1, at: 2 },
    { type: "task:retrying", taskId: "task-a", attempt: 2, error: new Error("late"), nextDelayMs: 1, at: 3 },
  ]);

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "task_event_after_terminal"), true);
});

test("Given ordered task events and scope events, verifyScopeProtocol passes", () => {
  const report = verifyScopeProtocol([
    { type: "scope:opened", scopeId: "scope-ok", parentId: null, at: 1 },
    { type: "task:started", taskId: "task-ok", scopeId: "scope-ok", name: "ok", kind: "custom", at: 2 },
    { type: "task:cancelled", taskId: "task-ok", reason: { kind: "manual", tag: "ok" }, durationMs: 1, at: 3 },
  ]);

  assert.equal(report.status, "pass");
  assert.deepEqual(report.findings, []);
});

test("Given declared time policy within budget, verifyTimePolicy passes", () => {
  const report = verifyTimePolicy(
    { type: "attempt", duration: 20 },
    { maxUpperBoundMs: 25 },
  );

  assert.equal(report.status, "pass");
  assert.equal(report.plan.upperBoundMs, 20);
  assert.deepEqual(report.findings, []);
});

test("Given timeout truncation, verifyTimePolicy reports a warning finding", () => {
  const report = verifyTimePolicy({
    type: "timeout",
    timeout: 250,
    policy: {
      type: "retry",
      attempt: { type: "attempt", duration: 100 },
      retry: { times: 4, initialDelay: 50, backoff: "fixed", jitter: false },
    },
  });
  const finding = report.findings.find((item) => item.code === "time_policy_warning");

  assert.equal(report.status, "warn");
  assert.equal(finding?.severity, "warn");
  assert.equal(finding?.estimatedMs, 550);
  assert.equal(finding?.limitMs, 250);
});

test("Given structural time-policy warning without bounds, verifyTimePolicy keeps optional fields absent", () => {
  const report = verifyTimePolicy({ type: "series", policies: [] });
  const finding = report.findings.find((item) => item.code === "time_policy_warning");

  assert.equal(report.status, "warn");
  assert.equal(finding?.estimatedMs, undefined);
  assert.equal(finding?.limitMs, undefined);
});

test("Given infeasible deadline and max bound, verifyTimePolicy reports errors", () => {
  const report = verifyTimePolicy({
    type: "deadline",
    now: 1_000,
    deadlineAt: 1_050,
    policy: { type: "attempt", duration: 100 },
  }, {
    maxUpperBoundMs: 40,
  });
  const codes = report.findings.map((finding) => finding.code).sort();

  assert.equal(report.status, "fail");
  assert.deepEqual(codes, ["deadline_infeasible", "time_budget_exceeded"]);
  assert.equal(report.findings.find((finding) => finding.code === "deadline_infeasible")?.severity, "error");
  assert.equal(report.findings.find((finding) => finding.code === "time_budget_exceeded")?.estimatedMs, 50);
});

test("Given owned source protocol, verifySourceProtocol passes with checked counts", () => {
  const report = verifySourceProtocol({
    version: "workit.source-protocol.v1",
    modules: [
      {
        moduleId: "upload.pipeline",
        functions: [
          {
            functionId: "uploadBatch",
            kind: "handler",
            uses: [
              { operation: "resource.acquire", target: "temp-dir" },
              { operation: "ctx.defer", target: "temp-dir" },
              { operation: "durable.side_effect", target: "object-store" },
              { operation: "activity.run", target: "object-store" },
              { operation: "promise.all", target: "files" },
              { operation: "run.pool", target: "files" },
              { operation: "run.retry", target: "object-store" },
              { operation: "time_policy.plan", target: "object-store" },
            ],
          },
          {
            functionId: "writeTool",
            kind: "agent_tool",
            uses: [
              { operation: "agent.tool", capability: "repo:write" },
              { operation: "durable.side_effect", target: "repo" },
              { operation: "receipt.append", target: "repo-write" },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(report.status, "pass");
  assert.equal(report.checkedModules, 1);
  assert.equal(report.checkedFunctions, 2);
  assert.equal(report.checkedUses, 11);
  assert.deepEqual(report.findings, []);
});

test("Given source protocol ownership gaps, verifySourceProtocol reports stable findings", () => {
  const report = verifySourceProtocol({
    modules: [
      {
        moduleId: "unsafe.pipeline",
        functions: [
          {
            functionId: "uploadBatch",
            kind: "handler",
            uses: [
              { operation: "resource.acquire", target: "temp-dir" },
              { operation: "durable.side_effect", target: "object-store" },
              { operation: "promise.all", target: "files" },
              { operation: "run.timeout", target: "object-store" },
            ],
          },
          {
            functionId: "writeTool",
            kind: "agent_tool",
            uses: [
              { operation: "agent.tool" },
              { operation: "durable.side_effect", target: "repo" },
              { operation: "activity.run", target: "repo" },
            ],
          },
        ],
      },
    ],
  });
  const codes = report.findings.map((finding) => finding.code).sort();

  assert.equal(report.status, "fail");
  assert.deepEqual(codes, [
    "source_agent_tool_without_authority",
    "source_durable_side_effect_without_evidence",
    "source_parallel_without_bound",
    "source_resource_without_cleanup",
    "source_time_policy_unplanned",
  ]);
  assert.equal(report.findings.every((finding) => finding.moduleId === "unsafe.pipeline"), true);
});

test("Given source protocol limits, verifySourceProtocol stays bounded", () => {
  const report = verifySourceProtocol({
    modules: [
      {
        moduleId: "bounded.one",
        functions: [
          {
            functionId: "tooManyUses",
            uses: [
              { operation: "resource.acquire" },
              { operation: "ctx.defer" },
            ],
          },
          {
            functionId: "notVisited",
            uses: [{ operation: "durable.side_effect" }],
          },
        ],
      },
      {
        moduleId: "bounded.two",
        functions: [
          {
            functionId: "notVisited",
            uses: [{ operation: "durable.side_effect" }],
          },
        ],
      },
    ],
  }, {
    maxModules: 1,
    maxFunctions: 1,
    maxUsesPerFunction: 1,
  });

  assert.equal(report.status, "fail");
  assert.equal(report.checkedModules, 1);
  assert.equal(report.checkedFunctions, 1);
  assert.equal(report.checkedUses, 1);
  assert.equal(report.findings.filter((finding) => finding.code === "source_protocol_limit_exceeded").length, 3);
  assert.equal(report.findings.some((finding) =>
    finding.code === "source_protocol_limit_exceeded"
      && finding.count === 2
      && finding.limit === 1
  ), true);
});

test("Given invalid source protocol limits, verifySourceProtocol rejects the contract", () => {
  assert.throws(
    () => verifySourceProtocol({ modules: [] }, { maxModules: 0 }),
    /maxModules must be a positive integer/,
  );
  assert.throws(
    () => verifySourceProtocol({ modules: [] }, { maxFunctions: 0.5 }),
    /maxFunctions must be a positive integer/,
  );
  assert.throws(
    () => verifySourceProtocol({ modules: [] }, { maxUsesPerFunction: -1 }),
    /maxUsesPerFunction must be a positive integer/,
  );
});

test("Given the root import, analysis helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("analyzeReceipt" in root, false);
  assert.equal("verifyReceipt" in root, false);
  assert.equal("verifyScopeProtocol" in root, false);
  assert.equal("verifySourceProtocol" in root, false);
});
