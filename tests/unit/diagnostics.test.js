/**
 * Diagnostics subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { diagnoseSnapshot } from "../../dist/diagnostics/index.js";

test("diagnoseSnapshot reports SRE-relevant snapshot and cleanup findings", () => {
  const report = diagnoseSnapshot({
    id: "scope-root",
    name: "root",
    status: "cancelling",
    startedAt: 1_000,
    pendingCount: 2,
    completedCount: 3,
    failedCount: 1,
    cancelledCount: 1,
    tasks: [
      {
        id: "task-old",
        name: "old-running-task",
        kind: "custom",
        status: "running",
        attempt: 1,
        startedAt: 2_000,
      },
    ],
    scopes: [
      {
        id: "scope-child",
        name: "child",
        status: "running",
        startedAt: 5_000,
        pendingCount: 1,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        tasks: [],
        scopes: [],
      },
    ],
  }, {
    now: 12_000,
    staleTaskMs: 5_000,
    events: [
      { type: "task:cleanup_timeout", taskId: "task-cleanup", timeoutMs: 50, at: 11_900 },
      { type: "scope:cleanup_timeout", scopeId: "scope-child", timeoutMs: 75, at: 11_950 },
    ],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.summary.oldPendingTasks, 1);
  assert.equal(report.summary.pendingChildScopes, 1);
  assert.equal(report.summary.cleanupTimeouts, 2);
  assert.equal(report.summary.cancellingScopes, 1);
  assert.deepEqual(
    report.findings.map((finding) => finding.code).sort(),
    [
      "cleanup_timeout",
      "cleanup_timeout",
      "old_pending_task",
      "pending_child_scope",
      "scope_cancelling",
    ]
  );
});

test("diagnoseSnapshot returns an ok report for a closed healthy snapshot", () => {
  const report = diagnoseSnapshot({
    id: "scope-ok",
    status: "closed",
    startedAt: 1_000,
    pendingCount: 0,
    completedCount: 3,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, { now: 2_000 });

  assert.equal(report.status, "ok");
  assert.equal(report.findings.length, 0);
  assert.equal(report.summary.pendingTasks, 0);
});

test("diagnoseSnapshot ignores non-cleanup events", () => {
  const report = diagnoseSnapshot({
    id: "scope-event-ok",
    status: "closed",
    startedAt: 1_000,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    now: 2_000,
    events: [
      { type: "scope:opened", scopeId: "scope-event-ok", parentId: undefined, at: 1_000 },
    ],
  });

  assert.equal(report.status, "ok");
  assert.equal(report.summary.cleanupTimeouts, 0);
  assert.equal(report.findings.length, 0);
});

test("diagnoseSnapshot counts young pending tasks without findings and ignores completed tasks", () => {
  const report = diagnoseSnapshot({
    id: "scope-young",
    status: "running",
    startedAt: 1_000,
    pendingCount: 1,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [
      {
        id: "task-young",
        name: "young",
        kind: "io",
        status: "pending",
        attempt: 1,
        startedAt: 1_900,
      },
      {
        id: "task-done",
        name: "done",
        kind: "io",
        status: "succeeded",
        attempt: 1,
        startedAt: 1_000,
        durationMs: 20,
      },
    ],
    scopes: [],
  }, {
    now: 2_000,
    staleTaskMs: 500,
  });

  assert.equal(report.status, "ok");
  assert.equal(report.summary.pendingTasks, 1);
  assert.equal(report.summary.oldPendingTasks, 0);
  assert.equal(report.findings.length, 0);
});

test("diagnoseSnapshot uses defaults and truncates findings", () => {
  const report = diagnoseSnapshot({
    id: "scope-truncated",
    status: "running",
    startedAt: 1_000,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    maxFindings: 1,
    events: [
      { type: "scope:cleanup_timeout", scopeId: "scope-a", timeoutMs: 1, at: 1 },
      { type: "scope:cleanup_timeout", scopeId: "scope-b", timeoutMs: 2, at: 2 },
    ],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.summary.cleanupTimeouts, 2);
  assert.equal(report.findings.length, 1);
  assert.equal(report.truncated, true);
});
