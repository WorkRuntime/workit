/**
 * Snapshot diagnostics for WorkJS scopes.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Diagnostics are pure over existing scope snapshots and typed engine events.
 * They do not subscribe to runtime state or pull in the core runtime, keeping
 * the SRE inspection surface available as an opt-in package subpath.
 */

import type { ScopeId, ScopeSnapshot, TaskEvent, TaskId, TaskSnapshot } from "../types/index.js";

const DEFAULT_STALE_TASK_MS = 30_000;
const DEFAULT_MAX_FINDINGS = 100;

/** Overall health result for a diagnostics report. */
export type DiagnosticsStatus = "ok" | "needs_attention";

/** Severity assigned to an SRE diagnostics finding. */
export type DiagnosticsSeverity = "info" | "warn" | "error";

/** Stable finding code emitted by the diagnostics subpath. */
export type DiagnosticsFindingCode =
  | "old_pending_task"
  | "pending_child_scope"
  | "scope_cancelling"
  | "cleanup_timeout";

/** Options for diagnosing an existing scope snapshot. */
export interface DiagnosticsOptions {
  /** Wall-clock timestamp used for age calculations. Defaults to `Date.now()`. */
  now?: number;

  /** Age threshold for pending or running tasks. Defaults to 30 seconds. */
  staleTaskMs?: number;

  /** Optional bounded event window to correlate cleanup timeout events. */
  events?: readonly TaskEvent[];

  /** Maximum findings retained in the report. Counts still include all findings. */
  maxFindings?: number;
}

/** One safe, bounded diagnostics finding. */
export interface DiagnosticsFinding {
  code: DiagnosticsFindingCode;
  severity: DiagnosticsSeverity;
  message: string;
  scopeId?: ScopeId;
  taskId?: TaskId;
  ageMs?: number;
  timeoutMs?: number;
  at?: number;
}

/** Aggregated counters for the diagnosed snapshot and optional event window. */
export interface DiagnosticsSummary {
  pendingTasks: number;
  oldPendingTasks: number;
  pendingChildScopes: number;
  cancellingScopes: number;
  cleanupTimeouts: number;
}

/** Report returned by `diagnoseSnapshot()`. */
export interface DiagnosticsReport {
  status: DiagnosticsStatus;
  generatedAt: number;
  summary: DiagnosticsSummary;
  findings: DiagnosticsFinding[];
  truncated: boolean;
}

/** Diagnoses a WorkJS scope snapshot plus an optional typed event window. */
export function diagnoseSnapshot(
  snapshot: ScopeSnapshot,
  opts: DiagnosticsOptions = {}
): DiagnosticsReport {
  const now = opts.now ?? Date.now();
  const staleTaskMs = opts.staleTaskMs ?? DEFAULT_STALE_TASK_MS;
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;
  const findings: DiagnosticsFinding[] = [];
  const summary: DiagnosticsSummary = {
    pendingTasks: 0,
    oldPendingTasks: 0,
    pendingChildScopes: 0,
    cancellingScopes: 0,
    cleanupTimeouts: 0,
  };

  const add = (finding: DiagnosticsFinding): void => {
    if (findings.length < maxFindings) findings.push(finding);
  };

  const visit = (scope: ScopeSnapshot, isRoot: boolean): void => {
    if (scope.status === "cancelling") {
      summary.cancellingScopes++;
      add({
        code: "scope_cancelling",
        severity: "warn",
        message: "Scope is cancelling",
        scopeId: scope.id,
      });
    }

    if (!isRoot && scope.status !== "closed") {
      summary.pendingChildScopes++;
      add({
        code: "pending_child_scope",
        severity: "warn",
        message: "Child scope is still pending",
        scopeId: scope.id,
      });
    }

    for (const task of scope.tasks) diagnoseTask(task, scope.id, now, staleTaskMs, summary, add);
    for (const child of scope.scopes) visit(child, false);
  };

  visit(snapshot, true);

  for (const event of opts.events ?? []) {
    if (event.type === "task:cleanup_timeout") {
      summary.cleanupTimeouts++;
      add({
        code: "cleanup_timeout",
        severity: "error",
        message: "Task cleanup timed out",
        taskId: event.taskId,
        timeoutMs: event.timeoutMs,
        at: event.at,
      });
    } else if (event.type === "scope:cleanup_timeout") {
      summary.cleanupTimeouts++;
      add({
        code: "cleanup_timeout",
        severity: "error",
        message: "Scope cleanup timed out",
        scopeId: event.scopeId,
        timeoutMs: event.timeoutMs,
        at: event.at,
      });
    }
  }

  const totalFindings = summary.oldPendingTasks
    + summary.pendingChildScopes
    + summary.cancellingScopes
    + summary.cleanupTimeouts;

  return {
    status: totalFindings === 0 ? "ok" : "needs_attention",
    generatedAt: now,
    summary,
    findings,
    truncated: totalFindings > findings.length,
  };
}

function diagnoseTask(
  task: TaskSnapshot,
  scopeId: ScopeId,
  now: number,
  staleTaskMs: number,
  summary: DiagnosticsSummary,
  add: (finding: DiagnosticsFinding) => void
): void {
  if (task.status !== "pending" && task.status !== "running") return;
  summary.pendingTasks++;

  const ageMs = Math.max(0, now - task.startedAt);
  if (ageMs < staleTaskMs) return;

  summary.oldPendingTasks++;
  add({
    code: "old_pending_task",
    severity: "warn",
    message: "Task has been pending too long",
    scopeId,
    taskId: task.id,
    ageMs,
  });
}
