/**
 * OpenTelemetry adapter tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { attachOpenTelemetry } from "../../dist/otel/index.js";

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
  };
}

function createFakeOtel() {
  const spans = [];
  const counters = new Map();
  const histograms = new Map();
  return {
    spans,
    counters,
    histograms,
    tracer: {
      startSpan(name, options) {
        const span = {
          name,
          options,
          attributes: {},
          events: [],
          exceptions: [],
          status: undefined,
          ended: false,
          setAttribute(key, value) {
            this.attributes[key] = value;
            return this;
          },
          addEvent(eventName, attributes) {
            this.events.push({ name: eventName, attributes });
            return this;
          },
          recordException(error) {
            this.exceptions.push(error);
          },
          setStatus(status) {
            this.status = status;
            return this;
          },
          end() {
            this.ended = true;
          },
        };
        spans.push(span);
        return span;
      },
    },
    meter: {
      createCounter(name) {
        const records = [];
        counters.set(name, records);
        return {
          add(value, attributes) {
            records.push({ value, attributes });
          },
        };
      },
      createHistogram(name) {
        const records = [];
        histograms.set(name, records);
        return {
          record(value, attributes) {
            records.push({ value, attributes });
          },
        };
      },
    },
  };
}

test("OpenTelemetry adapter creates task spans and bounded task metrics", async () => {
  const scope = createScopeHarness();
  const fake = createFakeOtel();
  const attachment = attachOpenTelemetry(scope, {
    tracer: fake.tracer,
    meter: fake.meter,
    includeIds: true,
  });

  scope.emit({ type: "task:started", taskId: "task-a", scopeId: "scope-a", name: "embed", kind: "llm", at: 1 });
  scope.emit({ type: "task:progress", taskId: "task-a", pct: 0.5, message: "half", data: { logLevel: "info" }, at: 2 });
  scope.emit({ type: "task:retrying", taskId: "task-a", attempt: 2, error: new Error("retry"), nextDelayMs: 5, at: 3 });
  scope.emit({ type: "task:succeeded", taskId: "task-a", durationMs: 12, at: 4 });

  assert.equal(attachment.activeSpanCount(), 0);
  assert.equal(fake.spans.length, 1);
  assert.equal(fake.spans[0].name, "workjs.task.embed");
  assert.equal(fake.spans[0].options.attributes["workjs.task.id"], "task-a");
  assert.deepEqual(fake.spans[0].events.map((event) => event.name), [
    "workjs.task.progress",
    "workjs.task.retrying",
  ]);
  assert.equal(fake.spans[0].events[0].attributes["workjs.progress.has_message"], true);
  assert.equal(fake.spans[0].events[0].attributes["workjs.log.level"], "info");
  assert.equal(fake.spans[0].status.code, 1);
  assert.equal(fake.spans[0].ended, true);
  assert.deepEqual(fake.counters.get("workjs.task.total")[0].attributes, {
    "workjs.task.kind": "llm",
    "workjs.task.outcome": "succeeded",
  });
  assert.equal(fake.histograms.get("workjs.task.duration")[0].value, 12);
});

test("OpenTelemetry adapter records failures cancellations and scope summaries", async () => {
  const scope = createScopeHarness();
  const fake = createFakeOtel();
  const attachment = attachOpenTelemetry(scope, {
    tracer: fake.tracer,
    meter: fake.meter,
    includeIds: false,
  });

  scope.emit({ type: "scope:opened", scopeId: "scope-a", parentId: null, at: 1 });
  scope.emit({ type: "task:started", taskId: "task-fail", scopeId: "scope-a", name: "fail", kind: "io", at: 2 });
  scope.emit({ type: "task:cleanup_failed", taskId: "task-fail", error: new Error("cleanup failed"), at: 3 });
  scope.emit({ type: "task:failed", taskId: "task-fail", error: new Error("failed"), durationMs: 4, at: 3 });
  scope.emit({ type: "task:started", taskId: "task-cancel", scopeId: "scope-a", name: "cancel", kind: "tool", at: 4 });
  scope.emit({ type: "task:cancelled", taskId: "task-cancel", reason: { kind: "manual", tag: "stop" }, durationMs: 5, at: 5 });
  scope.emit({ type: "scope:cleanup_failed", scopeId: "scope-a", error: new Error("scope cleanup failed"), at: 6 });
  scope.emit({ type: "scope:closing", scopeId: "scope-a", reason: "cancelled", at: 6 });
  scope.emit({ type: "scope:closed", scopeId: "scope-a", durationMs: 9, at: 7 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(attachment.activeSpanCount(), 0);
  assert.equal(fake.spans[0].exceptions[0].message, "failed");
  assert.equal(fake.spans[0].status.code, 2);
  assert.equal(fake.spans[0].events[0].name, "workjs.task.cleanup_failed");
  assert.equal(fake.spans[1].attributes["workjs.cancel.kind"], "manual");
  assert.equal(fake.spans[1].status.message, "cancelled:manual");
  assert.equal(fake.counters.get("workjs.scope.total")[0].attributes["workjs.scope.outcome"], "errored");
  assert.equal(fake.histograms.get("workjs.scope.duration")[0].value, 9);
  assert.equal(attachment.exportedCount(), 10);
});

test("OpenTelemetry adapter isolates telemetry failures and closes active spans on unsubscribe", () => {
  const scope = createScopeHarness();
  const fake = createFakeOtel();
  const attachment = attachOpenTelemetry(scope, {
    tracer: {
      startSpan() {
        throw new Error("otel unavailable");
      },
    },
    meter: fake.meter,
  });

  scope.emit({ type: "task:started", taskId: "task-bad", scopeId: "scope-a", name: "bad", kind: "io", at: 1 });
  assert.equal(attachment.droppedCount(), 1);

  const healthy = createFakeOtel();
  const healthyAttachment = attachOpenTelemetry(scope, {
    tracer: healthy.tracer,
    meter: healthy.meter,
  });
  scope.emit({ type: "task:started", taskId: "task-open", scopeId: "scope-a", name: "open", kind: "io", at: 2 });
  assert.equal(healthyAttachment.activeSpanCount(), 1);
  healthyAttachment.unsubscribe();
  assert.equal(healthyAttachment.activeSpanCount(), 0);
  assert.equal(healthy.spans[0].ended, true);
});

test("OpenTelemetry adapter covers default API and defensive event branches", async () => {
  const scope = createScopeHarness();
  const defaultAttachment = attachOpenTelemetry(scope);

  scope.emit({ type: "scope:opened", scopeId: "scope-default", parentId: null, at: 1 });
  scope.emit({ type: "task:progress", taskId: "missing-progress", at: 2 });
  scope.emit({ type: "task:retrying", taskId: "missing-retry", attempt: 2, error: "retry", nextDelayMs: 1, at: 3 });
  scope.emit({ type: "task:succeeded", taskId: "missing-success", durationMs: 1, at: 4 });
  scope.emit({ type: "task:failed", taskId: "missing-fail", error: "failed", durationMs: 1, at: 5 });
  scope.emit({ type: "task:cleanup_failed", taskId: "missing-cleanup", error: "cleanup", at: 5 });
  scope.emit({ type: "task:cancelled", taskId: "missing-cancel", reason: { kind: "manual", tag: "x" }, durationMs: 1, at: 6 });
  scope.emit({ type: "scope:cleanup_failed", scopeId: "scope-default", error: "cleanup", at: 6 });
  scope.emit({ type: "scope:closing", scopeId: "scope-default", reason: "completed", at: 7 });
  scope.emit({ type: "scope:closed", scopeId: "scope-default", durationMs: 8, at: 8 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(defaultAttachment.activeSpanCount(), 0);
  assert.equal(defaultAttachment.droppedCount(), 0);

  const fake = createFakeOtel();
  const attachment = attachOpenTelemetry(scope, {
    tracer: fake.tracer,
    meter: fake.meter,
  });

  scope.emit({ type: "task:started", taskId: "task-string-error", scopeId: "scope-a", name: "string-error", kind: "custom", at: 9 });
  scope.emit({ type: "task:progress", taskId: "task-string-error", data: null, at: 10 });
  scope.emit({ type: "task:progress", taskId: "task-string-error", data: { logLevel: 42 }, at: 10 });
  scope.emit({ type: "task:failed", taskId: "task-string-error", error: "plain failure", durationMs: 2, at: 11 });

  assert.equal(fake.spans[0].exceptions[0].message, "plain failure");
  assert.equal(fake.spans[0].status.message, "plain failure");
  assert.equal(fake.spans[0].events[0].attributes["workjs.log.level"], undefined);

  const throwingEnd = createFakeOtel();
  throwingEnd.tracer.startSpan = (name, options) => {
    const span = createFakeOtel().tracer.startSpan(name, options);
    span.end = () => {
      throw new Error("end failed");
    };
    throwingEnd.spans.push(span);
    return span;
  };
  const throwingAttachment = attachOpenTelemetry(scope, {
    tracer: throwingEnd.tracer,
    meter: throwingEnd.meter,
  });
  scope.emit({ type: "task:started", taskId: "task-end-fail", scopeId: "scope-a", name: "end-fail", kind: "io", at: 12 });
  scope.emit({ type: "task:succeeded", taskId: "task-end-fail", durationMs: 1, at: 13 });
  assert.equal(throwingAttachment.droppedCount(), 0);
  attachment.unsubscribe();
  throwingAttachment.unsubscribe();
  defaultAttachment.unsubscribe();
});
