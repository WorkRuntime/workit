/**
 * Scope tree renderer tests.
 *
 * @author Admilson B. F. Cossa
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { group, run, renderTree } from "../../dist/index.js";

test("scope.tree renders task status with ASCII fallback", async () => {
  const tree = await group(async (task) => {
    return await task(async (ctx) => {
      const child = ctx.scope.spawn(async () => "ok", { name: "leaf-task" });
      await child;
      return ctx.scope.tree({ ascii: true });
    }, { name: "tree-reader" });
  }, { name: "root-scope" });

  assert.match(tree, /root-scope/);
  assert.match(tree, /\[OK\] leaf-task/);
  assert.match(tree, /tasks \|/);
});

test("scope.tree renders nested scopes", async () => {
  const tree = await run.scope(async (scope) => {
    const child = scope.spawn(async () => "nested", { name: "nested-task" });
    await child;
    return scope.tree({ ascii: true });
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
