/**
 * Replay receipt subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { buildReceipt, createReceiptRecorder, redactReceipt } from "../../dist/replay/index.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

test("Given a completed scope, buildReceipt records terminal lifecycle evidence", async () => {
  let scopeRef;
  let recorder;

  await run.scope(async (scope) => {
    scopeRef = scope;
    recorder = createReceiptRecorder(scope, {
      clock: () => 10_000,
      receiptId: "receipt-completed",
    });

    await scope.spawn(async (ctx) => {
      ctx.report({ message: "phase", data: { step: "query" } });
      return "ok";
    }, { name: "receipt.query", kind: "io" });
  }, { name: "receipt-root" });

  const receipt = recorder.build(scopeRef.status());

  assert.equal(receipt.version, "workit.receipt.v1");
  assert.equal(receipt.receiptId, "receipt-completed");
  assert.equal(receipt.rootScopeId, scopeRef.id);
  assert.equal(receipt.terminal.outcome, "completed");
  assert.equal(receipt.summary.leakedTasks, 0);
  assert.equal(receipt.summary.retryEvents, 0);
  assert.ok(receipt.events.some((event) => event.type === "task:started" && event.name === "receipt.query"));
  assert.ok(receipt.events.some((event) => event.type === "scope:closed"));
});

test("Given a cancelled scope, buildReceipt preserves the typed cancellation reason", async () => {
  let scopeRef;
  let recorder;

  await assert.rejects(
    run.scope(async (scope) => {
      scopeRef = scope;
      recorder = createReceiptRecorder(scope, { receiptId: "receipt-cancelled" });
      const handle = scope.spawn(async (ctx) => {
        await sleep(5_000, ctx.signal);
      }, { name: "wait-for-cancel", kind: "io" });
      scope.cancel({ kind: "manual", tag: "manual_stop" });
      await handle;
    }, { name: "cancel-root" }),
    CancellationError,
  );

  const receipt = recorder.build(scopeRef.status());

  assert.equal(receipt.terminal.outcome, "cancelled");
  assert.deepEqual(receipt.terminal.cancelReason, { kind: "manual", tag: "manual_stop" });
  assert.equal(receipt.summary.cancelledTasks, 0);
  assert.equal(receipt.events.some((event) =>
    event.type === "task:cancelled"
      && event.reason?.kind === "manual"
      && event.reason.tag === "manual_stop"
  ), true);
});

test("Given cleanup timeout events, buildReceipt records safe cleanup evidence", async () => {
  let scopeRef;
  let recorder;

  await run.scope(async (scope) => {
    scopeRef = scope;
    recorder = createReceiptRecorder(scope, { receiptId: "receipt-cleanup" });
    await scope.spawn(run.bracket(
      async () => "resource",
      async () => "used",
      async () => new Promise(() => undefined),
      { timeout: 5 },
    ), { name: "cleanup.boundary", kind: "custom" });
  }, { name: "cleanup-root" });

  const receipt = recorder.build(scopeRef.status());

  assert.equal(receipt.terminal.outcome, "completed");
  assert.equal(receipt.summary.cleanupTimeouts, 1);
  assert.equal(receipt.summary.cleanupFailures, 0);
  assert.ok(receipt.events.some((event) => event.type === "task:cleanup_timeout" && event.timeoutMs === 5));
});

test("Given redaction policy, private receipt fields are removed or redacted", () => {
  const receipt = buildReceipt([
    {
      type: "task:progress",
      taskId: "task-private",
      data: {
        privateNote: "remove me",
        token: "secret-token",
        nested: { authorization: "bearer secret", safe: "ok" },
      },
      at: 1,
    },
  ], {
    id: "scope-private",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 1,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [
      {
        id: "task-private",
        name: "private-task",
        kind: "custom",
        status: "succeeded",
        attempt: 1,
        startedAt: 1,
        meta: { privateNote: "remove me", safe: "ok" },
      },
    ],
    scopes: [],
  }, {
    clock: () => 2,
    receiptId: "receipt-private",
  });

  const redacted = redactReceipt(receipt, {
    removeFields: ["privateNote"],
    redactFields: ["token", "authorization"],
  });
  const text = JSON.stringify(redacted);

  assert.equal(text.includes("remove me"), false);
  assert.equal(text.includes("secret-token"), false);
  assert.equal(text.includes("bearer secret"), false);
  assert.equal(text.includes("[redacted]"), true);
  assert.equal(text.includes("\"safe\":\"ok\""), true);
});

test("Given every event family, buildReceipt normalizes receipt evidence", () => {
  const circular = {};
  circular.self = circular;
  const receipt = buildReceipt([
    { type: "scope:opened", scopeId: "scope-events", parentId: null, at: 1 },
    { type: "task:started", taskId: "task-a", scopeId: "scope-events", name: "a", kind: "custom", at: 2 },
    { type: "task:retrying", taskId: "task-a", attempt: 2, error: "retry", nextDelayMs: 5, at: 3 },
    { type: "task:progress", taskId: "task-a", pct: 50, message: "half", data: ["safe"], at: 4 },
    { type: "task:cleanup_failed", taskId: "task-a", error: circular, at: 5 },
    { type: "task:cleanup_timeout", taskId: "task-a", timeoutMs: 6, at: 6 },
    { type: "task:failed", taskId: "task-a", error: new Error("failed"), durationMs: 7, at: 7 },
    { type: "scope:cleanup_failed", scopeId: "scope-events", error: new Error("scope cleanup"), at: 8 },
    { type: "scope:cleanup_timeout", scopeId: "scope-events", timeoutMs: 9, at: 9 },
    { type: "scope:closing", scopeId: "scope-events", reason: "errored", at: 10 },
    { type: "scope:closed", scopeId: "scope-events", durationMs: 11, droppedTelemetryEvents: 2, at: 11 },
  ], {
    id: "scope-events",
    name: "event-root",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 1,
    cancelledCount: 0,
    tasks: [],
    scopes: [
      {
        id: "scope-child",
        status: "running",
        startedAt: 2,
        pendingCount: 1,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        tasks: [],
        scopes: [],
      },
    ],
  }, {
    clock: () => 12,
    receiptId: "receipt-events",
    limitations: ["bounded_event_window"],
  });

  assert.equal(receipt.rootScopeName, "event-root");
  assert.equal(receipt.terminal.outcome, "failed");
  assert.equal(receipt.terminal.error.message, "scope cleanup");
  assert.equal(receipt.summary.cleanupFailures, 2);
  assert.equal(receipt.summary.cleanupTimeouts, 2);
  assert.equal(receipt.summary.retryEvents, 1);
  assert.equal(receipt.summary.droppedTelemetryEvents, 2);
  assert.equal(receipt.summary.totalScopes, 2);
  assert.equal(receipt.summary.pendingScopes, 1);
  assert.equal(receipt.limitations.includes("bounded_event_window"), true);
  assert.ok(receipt.events.some((event) => event.type === "task:cleanup_failed" && event.error.message === "[object Object]"));
});

test("Given sparse optional event fields, buildReceipt omits absent fields safely", () => {
  const receipt = buildReceipt([
    { type: "task:progress", taskId: "task-progress", at: 1 },
    { type: "task:failed", taskId: "task-failed", error: undefined, durationMs: 1, at: 2 },
    { type: "scope:closing", scopeId: "scope-sparse", reason: "cancelled", at: 3 },
    { type: "scope:closed", scopeId: "scope-sparse", durationMs: 4, at: 4 },
  ], {
    id: "scope-sparse",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-sparse",
  });

  const progress = receipt.events.find((event) => event.type === "task:progress");
  assert.equal("pct" in progress, false);
  assert.equal("message" in progress, false);
  assert.equal("data" in progress, false);
  assert.equal(receipt.terminal.outcome, "cancelled");
  assert.equal(receipt.terminal.cancelReason, undefined);
  assert.equal(receipt.events.some((event) => event.type === "scope:closed" && event.droppedTelemetryEvents === undefined), true);
  assert.ok(receipt.events.some((event) => event.type === "task:failed" && event.error.message === "undefined"));
});

test("Given a running snapshot, buildReceipt records a non-terminal receipt", () => {
  const receipt = buildReceipt([], {
    id: "scope-running",
    status: "running",
    startedAt: 1,
    pendingCount: 1,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-running",
  });

  assert.equal(receipt.terminal.outcome, "running");
  assert.equal(receipt.summary.pendingScopes, 1);
  assert.equal(receipt.summary.leakedTasks, 1);
});

test("Given a failed snapshot without failure event detail, buildReceipt records bounded terminal evidence", () => {
  const receipt = buildReceipt([
    { type: "scope:closing", scopeId: "scope-failed-no-error", reason: "errored", at: 1 },
  ], {
    id: "scope-failed-no-error",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 1,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-failed-no-error",
  });

  assert.equal(receipt.terminal.outcome, "failed");
  assert.equal("error" in receipt.terminal, false);
});

test("Given recorder max event window, createReceiptRecorder tracks dropped events", async () => {
  let scopeRef;
  let recorder;

  await run.scope(async (scope) => {
    scopeRef = scope;
    recorder = createReceiptRecorder(scope, { maxEvents: 1, receiptId: "receipt-dropped" });
    await scope.spawn(async (ctx) => {
      ctx.report({ message: "one" });
      ctx.report({ message: "two" });
    });
  });

  const receipt = recorder.build(scopeRef.status());

  assert.equal(recorder.events.length, 1);
  assert.ok(recorder.droppedEvents > 0);
  assert.ok(receipt.summary.droppedEvents > 0);
  assert.equal(receipt.limitations.includes("receipt_event_window_truncated"), true);
  recorder.unsubscribe();
});

test("Given invalid recorder event window, createReceiptRecorder rejects the contract", async () => {
  await run.scope(async (scope) => {
    assert.throws(() => createReceiptRecorder(scope, { maxEvents: 0 }), /maxEvents/);
  });
});

test("Given cancellation reasons with nested errors, buildReceipt serializes safe reason evidence", () => {
  const receipt = buildReceipt([
    {
      type: "task:cancelled",
      taskId: "task-parent",
      reason: { kind: "parent_failed", error: new Error("parent failed") },
      durationMs: 1,
      at: 1,
    },
    {
      type: "task:cancelled",
      taskId: "task-sibling",
      reason: { kind: "sibling_failed", siblingId: "task-parent", error: "sibling failed" },
      durationMs: 1,
      at: 2,
    },
    {
      type: "task:cancelled",
      taskId: "task-manual",
      reason: { kind: "manual", tag: "manual", data: { token: "secret" } },
      durationMs: 1,
      at: 3,
    },
    { type: "scope:closing", scopeId: "scope-cancel-reasons", reason: "cancelled", at: 4 },
  ], {
    id: "scope-cancel-reasons",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 3,
    tasks: [],
    scopes: [],
  });

  assert.equal(receipt.terminal.outcome, "cancelled");
  assert.equal(receipt.terminal.cancelReason.kind, "manual");
  assert.equal(JSON.stringify(receipt).includes("secret"), false);
  assert.ok(receipt.events.some((event) =>
    event.type === "task:cancelled"
      && event.reason.kind === "parent_failed"
      && event.reason.error.message === "parent failed"
  ));
});

test("Given non-manual cancellation reason, buildReceipt preserves the reason unchanged", () => {
  const receipt = buildReceipt([
    {
      type: "task:cancelled",
      taskId: "task-budget",
      reason: { kind: "budget", budgetKey: "tokens", limit: 1, spent: 2 },
      durationMs: 1,
      at: 1,
    },
    { type: "scope:closing", scopeId: "scope-budget", reason: "cancelled", at: 2 },
  ], {
    id: "scope-budget",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 1,
    tasks: [],
    scopes: [],
  });

  assert.deepEqual(receipt.terminal.cancelReason, { kind: "budget", budgetKey: "tokens", limit: 1, spent: 2 });
});

test("Given deep data and Error values, redactReceipt bounds nested evidence", () => {
  const receipt = buildReceipt([], {
    id: "scope-redact-depth",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-redact-depth",
  });
  const withExtra = {
    ...receipt,
    events: [
      {
        type: "task:progress",
        taskId: "task-error",
        at: 1,
        data: {
          error: new Error("nested"),
          deep: { one: { two: { three: "hidden" } } },
        },
      },
    ],
  };

  const redacted = redactReceipt(withExtra, { maxDepth: 2 });
  const text = JSON.stringify(redacted);

  assert.equal(text.includes("[max-depth]"), true);
  assert.equal(text.includes("nested"), false);
});

test("Given direct Error values, redactReceipt normalizes safe error evidence", () => {
  const receipt = buildReceipt([], {
    id: "scope-redact-error",
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    receiptId: "receipt-redact-error",
  });
  const redacted = redactReceipt({
    ...receipt,
    events: [
      {
        type: "task:progress",
        taskId: "task-error",
        at: 1,
        data: new Error("direct error"),
      },
    ],
  });

  assert.equal(redacted.events[0].data.name, "Error");
  assert.equal(redacted.events[0].data.message, "direct error");
});

test("Given the root import, replay helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("buildReceipt" in root, false);
  assert.equal("createReceiptRecorder" in root, false);
  assert.equal("redactReceipt" in root, false);
});
