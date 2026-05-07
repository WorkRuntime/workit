/**
 * Scope tree renderer tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { group, run, renderTree } from "../../dist/index.js";

test("renderTree renders live scope task status from a snapshot", async () => {
  const tree = await group(async (task) => {
    return await task(async (ctx) => {
      const child = ctx.scope.spawn(async () => "ok", { name: "leaf-task" });
      await child;
      return renderTree(ctx.scope.status(), { ascii: true });
    }, { name: "tree-reader" });
  }, { name: "root-scope" });

  assert.match(tree, /root-scope/);
  assert.match(tree, /\[OK\] leaf-task/);
  assert.match(tree, /tasks \|/);
});

test("renderTree renders nested live scope snapshots", async () => {
  const tree = await run.scope(async (scope) => {
    const child = scope.spawn(async () => "nested", { name: "nested-task" });
    await child;
    return renderTree(scope.status(), { ascii: true });
  }, { name: "child-scope" });

  assert.match(tree, /child-scope/);
  assert.match(tree, /nested-task/);
});

test("renderTree is pure over a supplied snapshot", () => {
  const output = renderTree({
    id: "scope-x",
    name: "manual",
    status: "running",
    startedAt: 0,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [{
      id: "task-x",
      name: "done",
      kind: "io",
      status: "succeeded",
      attempt: 1,
      startedAt: 0,
      durationMs: 4,
    }],
    scopes: [],
  }, { ascii: true });

  assert.match(output, /manual/);
  assert.match(output, /\[OK\] done \(succeeded, 4ms\)/);
  assert.match(output, /1 tasks/);
});

test("renderTree default options do not require Node process globals", () => {
  const originalProcess = globalThis.process;
  Object.defineProperty(globalThis, "process", { value: undefined, configurable: true });
  try {
    const output = renderTree({
      id: "scope-no-process",
      status: "running",
      startedAt: 0,
      pendingCount: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      tasks: [],
      scopes: [],
    });

    assert.match(output, /scope-no-process/);
  } finally {
    Object.defineProperty(globalThis, "process", { value: originalProcess, configurable: true });
  }
});
