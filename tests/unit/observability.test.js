/**
 * Observability exporter subpath tests.
 *
 * @author Admilson B. F. Cossa
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { attachTelemetryExporter } from "../../dist/observability/index.js";

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

const failedEvent = {
  type: "task:failed",
  taskId: "task-failed",
  error: new Error("failed"),
  durationMs: 10,
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
  await Promise.resolve();

  assert.deepEqual(exported.map((event) => event.taskId), ["task-failed", "task-cancelled", "task-slow"]);
  assert.equal(attachment.exportedCount(), 3);
  assert.equal(attachment.droppedCount(), 1);
  assert.equal(attachment.state(), "closed");

  attachment.unsubscribe();
  scope.emit(failedEvent);
  await Promise.resolve();
  assert.equal(exported.length, 3);
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
  await Promise.resolve();
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
    await Promise.resolve();
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
  await Promise.resolve();
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
  await Promise.resolve();
  assert.equal(rejected.length, 0);
  assert.equal(rejectedAttachment.droppedCount(), 2);
});

test("exporter circuit breaker opens drops while open and closes after half-open success", async () => {
  let now = 1_000;
  let attempts = 0;
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
    }
  );

  scope.emit(failedEvent);
  await Promise.resolve();
  assert.equal(attachment.state(), "closed");

  scope.emit(failedEvent);
  await Promise.resolve();
  assert.equal(attachment.state(), "open");

  scope.emit(failedEvent);
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.equal(attachment.droppedCount(), 3);

  now = 1_101;
  scope.emit(failedEvent);
  await Promise.resolve();
  assert.equal(attempts, 3);
  assert.equal(attachment.exportedCount(), 1);
  assert.equal(attachment.state(), "closed");
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
  await Promise.resolve();
  assert.equal(attachment.state(), "open");

  now = 1_101;
  scope.emit(failedEvent);
  await Promise.resolve();
  assert.equal(attachment.state(), "open");
  assert.equal(attachment.exportedCount(), 0);
  assert.equal(attachment.droppedCount(), 2);
});
