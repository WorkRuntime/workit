/**
 * Observability exporter subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { group } from "../../dist/index.js";
import {
  attachScopeSummaryExporter,
  attachTelemetryExporter,
  createCardinalitySafeMetricExporter,
} from "../../dist/observability/index.js";

function createScopeHarness() {
  const handlers = new Set();
  return {
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
    handlerCount() {
      return handlers.size;
    },
  };
}

async function flushExporter() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const failedEvent = {
  type: "task:failed",
  taskId: "task-failed",
  error: new Error("failed"),
  durationMs: 10,
  at: 1,
};

const taskCleanupFailedEvent = {
  type: "task:cleanup_failed",
  taskId: "task-cleanup",
  error: new Error("task cleanup failed"),
  at: 1,
};

const scopeCleanupFailedEvent = {
  type: "scope:cleanup_failed",
  scopeId: "scope-cleanup",
  error: new Error("scope cleanup failed"),
  at: 1,
};

const cancelledEvent = {
  type: "task:cancelled",
  taskId: "task-cancelled",
  reason: { kind: "manual", tag: "cancelled" },
  durationMs: 10,
  at: 1,
};

const slowSuccessEvent = {
  type: "task:succeeded",
  taskId: "task-slow",
  durationMs: 2_500,
  at: 1,
};

const fastSuccessEvent = {
  type: "task:succeeded",
  taskId: "task-fast",
  durationMs: 5,
  at: 1,
};

test("default errors-and-slow sampling exports failures cancellations and slow successes", async () => {
  const scope = createScopeHarness();
  const exported = [];
  const attachment = attachTelemetryExporter(scope, (event) => exported.push(event));

  scope.emit(failedEvent);
  scope.emit(cancelledEvent);
  scope.emit(slowSuccessEvent);
  scope.emit(fastSuccessEvent);
  scope.emit(taskCleanupFailedEvent);
  scope.emit(scopeCleanupFailedEvent);
  await flushExporter();

  assert.deepEqual(exported.map((event) => event.type), [
    "task:failed",
    "task:cancelled",
    "task:succeeded",
    "task:cleanup_failed",
    "scope:cleanup_failed",
  ]);
  assert.equal(attachment.exportedCount(), 5);
  assert.equal(attachment.droppedCount(), 1);
  assert.equal(attachment.queuedCount(), 0);
  assert.equal(attachment.state(), "closed");

  attachment.unsubscribe();
  scope.emit(failedEvent);
  await flushExporter();
  assert.equal(exported.length, 5);
});

test("off and all sampling modes enforce explicit volume policy", async () => {
  const offScope = createScopeHarness();
  const offAttachment = attachTelemetryExporter(offScope, () => {
    throw new Error("must not export");
  }, { sampling: { mode: "off" } });

  assert.equal(offScope.handlerCount(), 0);
  offScope.emit(failedEvent);
  assert.equal(offAttachment.exportedCount(), 0);
  assert.equal(offAttachment.droppedCount(), 0);
  assert.equal(offAttachment.state(), "closed");
  offAttachment.unsubscribe();

  const allScope = createScopeHarness();
  const exported = [];
  const allAttachment = attachTelemetryExporter(
    allScope,
    (event) => exported.push(event),
    { sampling: { mode: "all" } }
  );

  allScope.emit(fastSuccessEvent);
  await flushExporter();
  assert.deepEqual(exported.map((event) => event.taskId), ["task-fast"]);
  assert.equal(allAttachment.exportedCount(), 1);
});

test("head sampling accepts or drops the whole stream from one decision", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const defaultRandomScope = createScopeHarness();
    const defaultRandom = [];
    attachTelemetryExporter(
      defaultRandomScope,
      (event) => defaultRandom.push(event),
      { sampling: { mode: "head", rate: 1 } }
    );
    defaultRandomScope.emit(failedEvent);
    await flushExporter();
    assert.equal(defaultRandom.length, 1);
  } finally {
    Math.random = originalRandom;
  }

  const acceptedScope = createScopeHarness();
  const accepted = [];
  const acceptedAttachment = attachTelemetryExporter(
    acceptedScope,
    (event) => accepted.push(event),
    { sampling: { mode: "head", rate: 0.5, random: () => 0.1 } }
  );

  acceptedScope.emit(fastSuccessEvent);
  acceptedScope.emit(failedEvent);
  await flushExporter();
  assert.equal(accepted.length, 2);
  assert.equal(acceptedAttachment.droppedCount(), 0);

  const rejectedScope = createScopeHarness();
  const rejected = [];
  const rejectedAttachment = attachTelemetryExporter(
    rejectedScope,
    (event) => rejected.push(event),
    { sampling: { mode: "head", rate: 0.5, random: () => 0.9 } }
  );

  rejectedScope.emit(fastSuccessEvent);
  rejectedScope.emit(failedEvent);
  await flushExporter();
  assert.equal(rejected.length, 0);
  assert.equal(rejectedAttachment.droppedCount(), 2);
});

test("head sampling decision applies to child scope events bubbling to the root attachment", async () => {
  let attachment;

  await group(async (task) => {
    await task(async (ctx) => {
      attachment = attachTelemetryExporter(
        ctx.scope,
        () => {
          throw new Error("head sampling should drop the child scope stream");
        },
        { sampling: { mode: "head", rate: 0, random: () => 1 } }
      );

      await group(async (childTask) => {
        await childTask(async (childCtx) => {
          childCtx.report({ message: "child-progress" });
          return "child";
        }, { name: "child-task" });
      }, { name: "child-scope" });
    }, { name: "parent-task" });
  }, { name: "parent-scope" });

  await flushExporter();
  assert.ok(attachment.droppedCount() > 0);
});

test("telemetry exporter sanitizes events before export and drops rejected events", async () => {
  const scope = createScopeHarness();
  const exported = [];
  const attachment = attachTelemetryExporter(
    scope,
    (event) => exported.push(event),
    {
      sampling: { mode: "all" },
      sanitize(event) {
        if (event.taskId === "drop-me") return undefined;
        if (event.type === "task:failed") {
          return { ...event, error: new Error("redacted") };
        }
        return event;
      },
    }
  );

  scope.emit({ ...failedEvent, taskId: "secret-error", error: new Error("token=secret") });
  scope.emit({ ...failedEvent, taskId: "drop-me" });
  await flushExporter();

  assert.equal(exported.length, 1);
  assert.equal(exported[0].error.message, "redacted");
  assert.equal(attachment.exportedCount(), 1);
  assert.equal(attachment.droppedCount(), 1);
});

test("telemetry exporter isolates sanitizer failures", async () => {
  const scope = createScopeHarness();
  const exported = [];
  const attachment = attachTelemetryExporter(
    scope,
    (event) => exported.push(event),
    {
      sampling: { mode: "all" },
      sanitize() {
        throw new Error("redactor failed");
      },
    }
  );

  scope.emit(failedEvent);
  await flushExporter();

  assert.equal(exported.length, 0);
  assert.equal(attachment.exportedCount(), 0);
  assert.equal(attachment.droppedCount(), 1);
});

test("exporter circuit breaker opens drops while open and closes after half-open success", async () => {
  let now = 1_000;
  let attempts = 0;
  const stateChanges = [];
  const scope = createScopeHarness();
  const attachment = attachTelemetryExporter(
    scope,
    async () => {
      attempts++;
      if (attempts <= 2) throw new Error("backend down");
    },
    {
      sampling: { mode: "all" },
      circuitBreaker: { failureThreshold: 2, openForMs: 100, now: () => now },
      onStateChange: (event) => stateChanges.push(event),
    }
  );

  scope.emit(failedEvent);
  await flushExporter();
  assert.equal(attachment.state(), "closed");

  scope.emit(failedEvent);
  await flushExporter();
  assert.equal(attachment.state(), "open");

  scope.emit(failedEvent);
  await flushExporter();
  assert.equal(attempts, 2);
  assert.equal(attachment.droppedCount(), 3);

  now = 1_101;
  scope.emit(failedEvent);
  await flushExporter();
  assert.equal(attempts, 3);
  assert.equal(attachment.exportedCount(), 1);
  assert.equal(attachment.state(), "closed");
  assert.deepEqual(stateChanges.map((event) => `${event.from}->${event.to}:${event.reason}`), [
    "closed->open:failure_threshold",
    "open->half_open:reset_elapsed",
    "half_open->closed:success",
  ]);
});

test("half-open failure reopens the circuit", async () => {
  let now = 1_000;
  const scope = createScopeHarness();
  const attachment = attachTelemetryExporter(
    scope,
    async () => {
      throw new Error("still down");
    },
    {
      sampling: { mode: "all" },
      circuitBreaker: { failureThreshold: 1, openForMs: 100, now: () => now },
    }
  );

  scope.emit(failedEvent);
  await flushExporter();
  assert.equal(attachment.state(), "open");

  now = 1_101;
  scope.emit(failedEvent);
  await flushExporter();
  assert.equal(attachment.state(), "open");
  assert.equal(attachment.exportedCount(), 0);
  assert.equal(attachment.droppedCount(), 2);
});

test("exporter queue is bounded and can be disabled explicitly", async () => {
  const slowScope = createScopeHarness();
  const release = [];
  const exported = [];
  const attachment = attachTelemetryExporter(
    slowScope,
    async (event) => {
      await new Promise((resolve) => release.push(resolve));
      exported.push(event.taskId);
    },
    { sampling: { mode: "all" }, queue: { maxItems: 1 } }
  );

  slowScope.emit({ ...failedEvent, taskId: "first" });
  slowScope.emit({ ...failedEvent, taskId: "second" });
  slowScope.emit({ ...failedEvent, taskId: "third" });
  assert.equal(attachment.queuedCount(), 1);
  assert.equal(attachment.droppedCount(), 1);

  release.shift()();
  await flushExporter();
  while (release.length === 0) await flushExporter();
  release.shift()();
  await flushExporter();
  assert.deepEqual(exported, ["first", "third"]);

  const disabledScope = createScopeHarness();
  const disabled = attachTelemetryExporter(
    disabledScope,
    () => {
      throw new Error("must not export with zero queue");
    },
    { sampling: { mode: "all" }, queue: { maxItems: 0 } }
  );
  disabledScope.emit(failedEvent);
  await flushExporter();
  assert.equal(disabled.droppedCount(), 1);

  const byteScope = createScopeHarness();
  const byteRelease = [];
  const byteExported = [];
  const byteBounded = attachTelemetryExporter(
    byteScope,
    async (event) => {
      await new Promise((resolve) => byteRelease.push(resolve));
      byteExported.push(event.taskId);
    },
    {
      sampling: { mode: "all" },
      queue: { maxItems: 10, maxBytes: 10, estimateBytes: () => 6 },
    }
  );

  byteScope.emit({ ...failedEvent, taskId: "byte-first" });
  byteScope.emit({ ...failedEvent, taskId: "byte-second" });
  byteScope.emit({ ...failedEvent, taskId: "byte-third" });
  assert.equal(byteBounded.queuedCount(), 1);
  assert.equal(byteBounded.droppedCount(), 1);

  byteRelease.shift()();
  await flushExporter();
  while (byteRelease.length === 0) await flushExporter();
  byteRelease.shift()();
  await flushExporter();
  assert.deepEqual(byteExported, ["byte-first", "byte-third"]);

  const tooLargeScope = createScopeHarness();
  const tooLarge = attachTelemetryExporter(
    tooLargeScope,
    () => {
      throw new Error("oversized events must not export");
    },
    {
      sampling: { mode: "all" },
      queue: { maxBytes: 5, estimateBytes: () => 6 },
    }
  );
  tooLargeScope.emit(failedEvent);
  await flushExporter();
  assert.equal(tooLarge.droppedCount(), 1);

  const cyclicScope = createScopeHarness();
  const cyclic = { type: "task:progress", taskId: "cyclic-task", at: 1 };
  cyclic.self = cyclic;
  const cyclicAttachment = attachTelemetryExporter(
    cyclicScope,
    () => {
      throw new Error("cyclic oversized events must not export");
    },
    {
      sampling: { mode: "all" },
      queue: { maxBytes: 10 },
    }
  );
  cyclicScope.emit(cyclic);
  await flushExporter();
  assert.equal(cyclicAttachment.droppedCount(), 1);

  const undefinedScope = createScopeHarness();
  const undefinedEvents = [];
  const undefinedAttachment = attachTelemetryExporter(
    undefinedScope,
    (event) => undefinedEvents.push(event),
    {
      sampling: { mode: "all" },
      queue: { maxBytes: 10 },
    }
  );
  undefinedScope.emit(undefined);
  await flushExporter();
  assert.equal(undefinedAttachment.exportedCount(), 1);
  assert.deepEqual(undefinedEvents, [undefined]);
});

test("scope summary exporter emits one aggregate record per closed scope", async () => {
  const scope = createScopeHarness();
  const summaries = [];
  const attachment = attachScopeSummaryExporter(scope, (summary) => summaries.push(summary));

  scope.emit({ type: "scope:closed", scopeId: "unknown", durationMs: 1, at: 1 });
  scope.emit({ type: "task:progress", taskId: "task-before-open", at: 1 });
  scope.emit({ type: "scope:opened", scopeId: "scope-a", parentId: null, at: 1 });
  scope.emit({ type: "task:progress", taskId: "task-before-owner", at: 1 });
  scope.emit({ type: "task:started", taskId: "task-a", scopeId: "scope-a", name: "batch", kind: "io", at: 2 });
  scope.emit({ type: "task:progress", taskId: "task-a", pct: 0.5, at: 2 });
  scope.emit({ type: "task:succeeded", taskId: "task-a", durationMs: 1, at: 3 });
  scope.emit({ type: "task:retrying", taskId: "task-a", attempt: 2, error: new Error("retry"), nextDelayMs: 1, at: 3 });
  scope.emit({ type: "task:failed", taskId: "task-a", error: new Error("failed"), durationMs: 2, at: 4 });
  scope.emit({ type: "task:cleanup_failed", taskId: "task-a", error: new Error("task cleanup failed"), at: 4 });
  scope.emit({ type: "task:started", taskId: "task-b", scopeId: "scope-a", name: "cancelled", kind: "io", at: 5 });
  scope.emit({ type: "task:cancelled", taskId: "task-b", reason: { kind: "manual", tag: "stop" }, durationMs: 1, at: 6 });
  scope.emit({ type: "scope:cleanup_failed", scopeId: "scope-a", error: new Error("scope cleanup failed"), at: 6 });
  scope.emit({ type: "scope:closing", scopeId: "scope-a", reason: "errored", at: 7 });
  scope.emit({ type: "scope:closed", scopeId: "scope-a", durationMs: 9, droppedTelemetryEvents: 2, at: 8 });
  await flushExporter();

  assert.equal(attachment.exportedCount(), 1);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].outcome, "errored");
  assert.deepEqual(summaries[0].taskCounts, {
    started: 2,
    succeeded: 1,
    failed: 1,
    cancelled: 1,
    retried: 1,
    cleanupFailed: 2,
  });
  assert.equal(summaries[0].droppedTelemetryEvents, 2);

  scope.emit({ type: "scope:opened", scopeId: "scope-errored-closing", parentId: null, at: 8 });
  scope.emit({ type: "scope:closing", scopeId: "scope-errored-closing", reason: "errored", at: 8 });
  scope.emit({ type: "scope:closed", scopeId: "scope-errored-closing", durationMs: 1, at: 8 });
  await flushExporter();
  assert.equal(summaries[1].outcome, "errored");

  scope.emit({ type: "scope:opened", scopeId: "scope-b", parentId: "scope-a", at: 9 });
  scope.emit({ type: "task:started", taskId: "task-c", scopeId: "scope-b", name: "cancelled", kind: "io", at: 9 });
  scope.emit({ type: "task:cancelled", taskId: "task-c", reason: { kind: "manual", tag: "stop" }, durationMs: 1, at: 10 });
  scope.emit({ type: "scope:closing", scopeId: "scope-b", reason: "cancelled", at: 10 });
  scope.emit({ type: "scope:closed", scopeId: "scope-b", durationMs: 1, at: 11 });
  await flushExporter();
  assert.equal(summaries[2].outcome, "cancelled");
});

test("scope summary exporter applies sanitizer drops before aggregation", async () => {
  const scope = createScopeHarness();
  const summaries = [];
  const attachment = attachScopeSummaryExporter(
    scope,
    (summary) => summaries.push(summary),
    {
      sanitize() {
        return undefined;
      },
    }
  );

  scope.emit({ type: "scope:opened", scopeId: "scope-drop", parentId: null, at: 1 });
  scope.emit({ type: "scope:closed", scopeId: "scope-drop", durationMs: 1, at: 2 });
  await flushExporter();

  assert.equal(summaries.length, 0);
  assert.equal(attachment.exportedCount(), 0);
  assert.equal(attachment.droppedCount(), 2);
});

test("cardinality-safe metric exporter rejects unbounded labels", async () => {
  const metrics = [];
  const exporter = createCardinalitySafeMetricExporter(
    (metric) => metrics.push(metric),
    { allowedLabels: ["outcome", "taskKind"] }
  );

  await exporter({ name: "workjs_task_total", value: 1, labels: { outcome: "ok", taskKind: "io" } });
  await createCardinalitySafeMetricExporter((metric) => metrics.push(metric))({ name: "workjs_without_labels", value: 1 });
  assert.equal(metrics.length, 2);

  await assert.rejects(exporter({ name: "bad metric", value: 1 }), /Invalid metric name/);
  await assert.rejects(exporter({ name: "workjs_bad", value: Number.NaN }), /finite/);
  await assert.rejects(exporter({ name: "workjs_bad", value: 1, labels: { taskId: "task-1" } }), /cardinality-safe/);
  await assert.rejects(exporter({ name: "workjs_bad", value: 1, labels: { region: "us" } }), /allowed label/);
  await assert.rejects(exporter({
    name: "workjs_bad",
    value: 1,
    labels: { outcome: "x".repeat(65) },
  }), /too long/);
});
