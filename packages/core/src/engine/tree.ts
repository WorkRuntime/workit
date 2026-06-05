/**
 * Scope tree renderer.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure rendering over `ScopeSnapshot`; no task state is read here. This lets
 * diagnostics and future exporters reuse the same snapshot contract without
 * depending on the live engine.
 */

import type { ScopeSnapshot, TaskSnapshot, TreeOpts } from "../types/index.js";

interface Glyphs {
  branch: string;
  last: string;
  pipe: string;
  space: string;
  pending: string;
  running: string;
  succeeded: string;
  failed: string;
  cancelled: string;
}

const ASCII: Glyphs = {
  branch: "+-- ",
  last: "\\-- ",
  pipe: "|   ",
  space: "    ",
  pending: "[ ]",
  running: "[..]",
  succeeded: "[OK]",
  failed: "[X]",
  cancelled: "[!]",
};

const UNICODE: Glyphs = {
  branch: "├─ ",
  last: "└─ ",
  pipe: "│  ",
  space: "   ",
  pending: "⏸",
  running: "⏳",
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
};

/** Renders a scope snapshot as a status tree plus aggregate summary. */
export function renderTree(snapshot: ScopeSnapshot, opts: TreeOpts = {}): string {
  const ascii = opts.ascii ?? defaultAscii();
  const glyphs = ascii ? ASCII : UNICODE;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const lines = [snapshot.name ?? snapshot.id];

  renderChildren(snapshot, "", glyphs, lines, opts, 0, maxDepth);
  lines.push("");
  lines.push(renderSummary(snapshot, ascii));
  return lines.join("\n");
}

function defaultAscii(): boolean {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: { NO_UNICODE?: string }; stdout?: { isTTY?: boolean } };
  };
  return runtime.process?.env?.NO_UNICODE === "1" || runtime.process?.stdout?.isTTY === false;
}

function renderChildren(
  snapshot: ScopeSnapshot,
  prefix: string,
  glyphs: Glyphs,
  lines: string[],
  opts: TreeOpts,
  depth: number,
  maxDepth: number
): void {
  if (depth >= maxDepth) return;
  const children: Array<{ kind: "task"; value: TaskSnapshot } | { kind: "scope"; value: ScopeSnapshot }> = [
    ...snapshot.tasks.map((value) => ({ kind: "task" as const, value })),
    ...snapshot.scopes.map((value) => ({ kind: "scope" as const, value })),
  ];

  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    const marker = isLast ? glyphs.last : glyphs.branch;
    const nextPrefix = prefix + (isLast ? glyphs.space : glyphs.pipe);
    if (child.kind === "task") {
      lines.push(`${prefix}${marker}${renderTask(child.value, glyphs, opts)}`);
    } else {
      lines.push(`${prefix}${marker}${child.value.name ?? child.value.id} (${child.value.status})`);
      renderChildren(child.value, nextPrefix, glyphs, lines, opts, depth + 1, maxDepth);
    }
  });
}

function renderTask(task: TaskSnapshot, glyphs: Glyphs, opts: TreeOpts): string {
  const icon = task.status === "succeeded"
    ? glyphs.succeeded
    : task.status === "failed"
      ? glyphs.failed
      : task.status === "cancelled"
        ? glyphs.cancelled
        : task.status === "running"
          ? glyphs.running
          : glyphs.pending;

  const details: string[] = [task.status];
  if ((opts.showDurations ?? true) && task.durationMs !== undefined) {
    details.push(`${task.durationMs}ms`);
  }
  if ((opts.showProgress ?? true) && task.progress?.pct !== undefined) {
    details.push(`${Math.round(task.progress.pct * 100)}%`);
  }

  return `${icon} ${task.name} (${details.join(", ")})`;
}

function renderSummary(snapshot: ScopeSnapshot, ascii: boolean): string {
  const totals = countSnapshot(snapshot);
  if (ascii) {
    return `${totals.total} tasks | ${totals.succeeded} [OK] | ${totals.failed} [X] | ${totals.cancelled} [!] | ${totals.pending} [..]`;
  }
  return `${totals.total} tasks · ${totals.succeeded} ✓ · ${totals.failed} ✗ · ${totals.cancelled} ⊘ · ${totals.pending} ⏳`;
}

function countSnapshot(snapshot: ScopeSnapshot): {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  pending: number;
} {
  const own = {
    total: snapshot.tasks.length,
    succeeded: snapshot.completedCount,
    failed: snapshot.failedCount,
    cancelled: snapshot.cancelledCount,
    pending: snapshot.pendingCount,
  };

  for (const child of snapshot.scopes) {
    const next = countSnapshot(child);
    own.total += next.total;
    own.succeeded += next.succeeded;
    own.failed += next.failed;
    own.cancelled += next.cancelled;
    own.pending += next.pending;
  }

  return own;
}
