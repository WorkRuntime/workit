/**
 * Bench 18 -- diagnoseSnapshot finding codes.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: hand-craft four ScopeSnapshot inputs that each trigger one of the
 * stable finding codes the diagnostics subpath emits:
 *
 *   old_pending_task        -- a task that has been running well past staleTaskMs
 *   pending_child_scope     -- a child scope still active when the parent should
 *                             be closing
 *   scope_cancelling        -- a scope that has begun cancelling but is not yet
 *                             closed
 *   cleanup_timeout         -- the diagnoses surfaces a recent
 *                             task:cleanup_timeout event in the bounded window
 *
 * The bench asserts each code can be produced and that the report's status
 * flips to needs_attention when there are findings.
 */

import assert from "node:assert/strict";
import { diagnoseSnapshot } from "../../dist/diagnostics/index.js";
import { jsonReplacer } from "./lib/baselines.mjs";

const NOW = 1_000_000_000;
const STALE_MS = 30_000;

function makeTask(over) {
  return {
    id: "task-1",
    name: "io",
    kind: "io",
    status: "running",
    attempt: 1,
    startedAt: NOW - 60_000,         // very old by default
    ...over,
  };
}

function makeSnapshot(over) {
  return {
    id: "scope-1",
    name: "root",
    status: "running",
    startedAt: NOW - 60_000,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
    ...over,
  };
}

const result = { bench: "18-diagnostics-finding-codes", scenarios: {} };

// 1. Healthy snapshot
{
  const report = diagnoseSnapshot(makeSnapshot({ pendingCount: 0 }), { now: NOW, staleTaskMs: STALE_MS });
  result.scenarios.healthy = { status: report.status, findingCodes: report.findings.map((f) => f.code) };
  assert.equal(report.status, "ok");
  assert.equal(report.findings.length, 0);
}

// 2. Old pending task
{
  const snap = makeSnapshot({
    pendingCount: 1,
    tasks: [makeTask({ status: "pending" })],
  });
  const report = diagnoseSnapshot(snap, { now: NOW, staleTaskMs: STALE_MS });
  result.scenarios.old_pending_task = { status: report.status, findingCodes: report.findings.map((f) => f.code) };
  assert.equal(report.status, "needs_attention");
  assert.ok(report.findings.some((f) => f.code === "old_pending_task"));
}

// 3. Cancelling scope
{
  const snap = makeSnapshot({ status: "cancelling" });
  const report = diagnoseSnapshot(snap, { now: NOW, staleTaskMs: STALE_MS });
  result.scenarios.scope_cancelling = { status: report.status, findingCodes: report.findings.map((f) => f.code) };
  assert.equal(report.status, "needs_attention");
  assert.ok(report.findings.some((f) => f.code === "scope_cancelling"));
}

// 4. Pending child scope
{
  const child = makeSnapshot({
    id: "scope-child", name: "child", status: "running", pendingCount: 1,
    tasks: [makeTask({ id: "task-c", status: "pending" })],
  });
  const snap = makeSnapshot({ scopes: [child], pendingCount: 1 });
  const report = diagnoseSnapshot(snap, { now: NOW, staleTaskMs: STALE_MS });
  result.scenarios.pending_child_scope = {
    status: report.status,
    findingCodes: report.findings.map((f) => f.code),
  };
  assert.equal(report.status, "needs_attention");
  assert.ok(report.findings.some((f) => f.code === "pending_child_scope"));
  // The recursion should also find the child's old pending task.
  assert.ok(report.findings.some((f) => f.code === "old_pending_task"));
}

// 5. Cleanup timeout via the events window
{
  const snap = makeSnapshot();
  const events = [
    {
      type: "task:cleanup_timeout",
      taskId: "task-cleanup",
      timeoutMs: 250,
      durationMs: 252,
      at: NOW - 1_000,
    },
  ];
  const report = diagnoseSnapshot(snap, { now: NOW, staleTaskMs: STALE_MS, events });
  result.scenarios.cleanup_timeout = {
    status: report.status,
    findingCodes: report.findings.map((f) => f.code),
  };
  assert.equal(report.status, "needs_attention");
  assert.ok(report.findings.some((f) => f.code === "cleanup_timeout"));
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
