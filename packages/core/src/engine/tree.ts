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

type Glyphs = readonly [string, string, string, string, string, string, string, string, string];

const enum Glyph {
  Branch,
  Last,
  Pipe,
  Space,
  Pending,
  Running,
  Succeeded,
  Failed,
  Cancelled,
}

const STATUS_GLYPH = {
  pending: Glyph.Pending,
  running: Glyph.Running,
  succeeded: Glyph.Succeeded,
  failed: Glyph.Failed,
  cancelled: Glyph.Cancelled,
} as const;

const ASCII: Glyphs = [
  "+-- ", "\\-- ", "|   ", "    ", "[ ]", "[..]", "[OK]", "[X]", "[!]",
];

const UNICODE: Glyphs = [
  "├─ ", "└─ ", "│  ", "   ", "⏸", "⏳", "✓", "✗", "⊘",
];

/** Renders a scope snapshot as a status tree plus aggregate summary. */
export function renderTree(snapshot: ScopeSnapshot, opts: TreeOpts = {}): string {
  const process = (globalThis as typeof globalThis & {
    process?: { env?: { NO_UNICODE?: string }; stdout?: { isTTY?: boolean } };
  }).process;
  const ascii = opts.ascii
    ?? (process?.env?.NO_UNICODE === "1" || process?.stdout?.isTTY === false);
  const glyphs = ascii ? ASCII : UNICODE;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const lines = [snapshot.name ?? snapshot.id];

  renderChildren(snapshot, "", glyphs, lines, opts, 0, maxDepth);
  lines.push("", renderSummary(snapshot, glyphs, ascii));
  return lines.join("\n");
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
  const children: Array<TaskSnapshot | ScopeSnapshot> = [...snapshot.tasks, ...snapshot.scopes];

  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    const marker = isLast ? glyphs[Glyph.Last] : glyphs[Glyph.Branch];
    const nextPrefix = prefix + (isLast ? glyphs[Glyph.Space] : glyphs[Glyph.Pipe]);
    if ("tasks" in child) {
      lines.push(`${prefix}${marker}${child.name ?? child.id} (${child.status})`);
      renderChildren(child, nextPrefix, glyphs, lines, opts, depth + 1, maxDepth);
    } else {
      lines.push(`${prefix}${marker}${renderTask(child, glyphs, opts)}`);
    }
  });
}

function renderTask(task: TaskSnapshot, glyphs: Glyphs, opts: TreeOpts): string {
  const details: string[] = [task.status];
  if (opts.showDurations !== false && task.durationMs !== undefined) {
    details.push(`${task.durationMs}ms`);
  }
  if (opts.showProgress !== false && task.progress?.pct !== undefined) {
    details.push(`${Math.round(task.progress.pct * 100)}%`);
  }

  return `${glyphs[STATUS_GLYPH[task.status]]} ${task.name} (${details.join(", ")})`;
}

function renderSummary(snapshot: ScopeSnapshot, glyphs: Glyphs, ascii: boolean): string {
  const totals = countSnapshot(snapshot);
  const separator = ascii ? " | " : " · ";
  return `${totals[TotalCount.All]} tasks${separator}${totals[TotalCount.Succeeded]} ${glyphs[Glyph.Succeeded]}`
    + `${separator}${totals[TotalCount.Failed]} ${glyphs[Glyph.Failed]}`
    + `${separator}${totals[TotalCount.Cancelled]} ${glyphs[Glyph.Cancelled]}`
    + `${separator}${totals[TotalCount.Pending]} ${glyphs[Glyph.Running]}`;
}

const enum TotalCount {
  All,
  Succeeded,
  Failed,
  Cancelled,
  Pending,
}

type SnapshotTotals = [number, number, number, number, number];

function countSnapshot(
  snapshot: ScopeSnapshot,
  totals: SnapshotTotals = [0, 0, 0, 0, 0]
): SnapshotTotals {
  totals[TotalCount.All] += snapshot.tasks.length;
  totals[TotalCount.Succeeded] += snapshot.completedCount;
  totals[TotalCount.Failed] += snapshot.failedCount;
  totals[TotalCount.Cancelled] += snapshot.cancelledCount;
  totals[TotalCount.Pending] += snapshot.pendingCount;

  for (const child of snapshot.scopes) {
    countSnapshot(child, totals);
  }

  return totals;
}
