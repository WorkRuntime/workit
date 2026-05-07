/**
 * OpenTelemetry adapter for WorkIt.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This subpath is intentionally opt-in. The core package never imports
 * OpenTelemetry; applications that want OTel import `@workit/core/otel` and provide
 * or configure the OpenTelemetry API in their runtime.
 */

import {
  SpanKind,
  SpanStatusCode,
  metrics,
  trace,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { CancelReason, Scope, TaskEvent, TaskId, TaskKind } from "../types/index.js";
import {
  attachScopeSummaryExporter,
  type ScopeSummary,
  type TelemetryExportOptions,
  type TaskEventSanitizer,
} from "../observability/index.js";

/** Options used to attach WorkIt events to OpenTelemetry. */
export interface OpenTelemetryOptions {
  tracer?: Tracer;
  meter?: Meter;
  instrumentationName?: string;
  instrumentationVersion?: string;
  telemetry?: TelemetryExportOptions;
  includeIds?: boolean;
}

/** Attachment returned by `attachOpenTelemetry()`. */
export interface OpenTelemetryAttachment {
  unsubscribe(): void;
  exportedCount(): number;
  droppedCount(): number;
  activeSpanCount(): number;
}

interface TaskSpanState {
  span: Span;
  name: string;
  kind: TaskKind;
}

/** Attaches OTel spans and bounded metrics to a WorkIt scope event stream. */
export function attachOpenTelemetry(
  scope: Pick<Scope, "onEvent">,
  opts: OpenTelemetryOptions = {}
): OpenTelemetryAttachment {
  const instrumentationName = opts.instrumentationName ?? "workit";
  const instrumentationVersion = opts.instrumentationVersion ?? "0.1.0";
  const tracer = opts.tracer ?? trace.getTracer(instrumentationName, instrumentationVersion);
  const meter = opts.meter ?? metrics.getMeter(instrumentationName, instrumentationVersion);
  const taskCounter = meter.createCounter("workit.task.total", { unit: "1" });
  const taskDuration = meter.createHistogram("workit.task.duration", { unit: "ms" });
  const scopeCounter = meter.createCounter("workit.scope.total", { unit: "1" });
  const scopeDuration = meter.createHistogram("workit.scope.duration", { unit: "ms" });
  const spans = new Map<TaskId, TaskSpanState>();
  let exported = 0;
  let dropped = 0;

  const unsubscribeEvents = scope.onEvent((event) => {
    try {
      const sanitized = sanitizeTaskEvent(event, opts.telemetry?.sanitize);
      if (sanitized === undefined) {
        dropped++;
        return;
      }
      handleTaskEvent(sanitized, spans, tracer, taskCounter, taskDuration, opts.includeIds ?? false);
      exported++;
    } catch {
      dropped++;
    }
  });

  const summaryTelemetry = omitSanitizer(opts.telemetry);
  const summaryAttachment = attachScopeSummaryExporter(
    scope,
    (summary) => {
      recordScopeSummary(summary, scopeCounter, scopeDuration);
    },
    summaryTelemetry
  );

  return {
    unsubscribe() {
      unsubscribeEvents();
      summaryAttachment.unsubscribe();
      for (const { span } of spans.values()) safeEnd(span);
      spans.clear();
    },
    exportedCount() {
      return exported + summaryAttachment.exportedCount();
    },
    droppedCount() {
      return dropped + summaryAttachment.droppedCount();
    },
    activeSpanCount() {
      return spans.size;
    },
  };
}

function omitSanitizer(opts: TelemetryExportOptions | undefined): TelemetryExportOptions | undefined {
  if (opts === undefined) return undefined;
  const { sanitize: _sanitize, ...summaryTelemetry } = opts;
  return summaryTelemetry;
}

function sanitizeTaskEvent(
  event: TaskEvent,
  sanitize: TaskEventSanitizer | undefined
): TaskEvent | undefined {
  if (sanitize === undefined) return event;
  return sanitize(event);
}

function handleTaskEvent(
  event: TaskEvent,
  spans: Map<TaskId, TaskSpanState>,
  tracer: Tracer,
  taskCounter: CounterLike,
  taskDuration: HistogramLike,
  includeIds: boolean
): void {
  switch (event.type) {
    case "task:started":
      startTaskSpan(event, spans, tracer, includeIds);
      break;
    case "task:retrying":
      spans.get(event.taskId)?.span.addEvent("workit.task.retrying", {
        "workit.retry.attempt": event.attempt,
        "workit.retry.next_delay_ms": event.nextDelayMs,
      });
      break;
    case "task:progress":
      recordProgress(spans.get(event.taskId)?.span, event);
      break;
    case "task:cleanup_failed":
      recordTaskCleanupFailure(spans.get(event.taskId)?.span, event);
      break;
    case "task:cleanup_timeout":
      recordTaskCleanupTimeout(spans.get(event.taskId)?.span, event);
      break;
    case "task:succeeded":
      finishTask(event.taskId, "succeeded", event.durationMs, spans, taskCounter, taskDuration);
      break;
    case "task:failed":
      failTask(event.taskId, event.error, event.durationMs, spans, taskCounter, taskDuration);
      break;
    case "task:cancelled":
      cancelTask(event.taskId, event.reason, event.durationMs, spans, taskCounter, taskDuration);
      break;
    case "scope:opened":
    case "scope:cleanup_failed":
    case "scope:cleanup_timeout":
    case "scope:closing":
    case "scope:closed":
      break;
  }
}

function startTaskSpan(
  event: Extract<TaskEvent, { type: "task:started" }>,
  spans: Map<TaskId, TaskSpanState>,
  tracer: Tracer,
  includeIds: boolean
): void {
  const attributes: Attributes = {
    "workit.task.name": event.name,
    "workit.task.kind": event.kind,
  };
  if (includeIds) {
    attributes["workit.task.id"] = event.taskId;
    attributes["workit.scope.id"] = event.scopeId;
  }

  const span = tracer.startSpan(`workit.task.${event.name}`, {
    kind: SpanKind.INTERNAL,
    attributes,
  });
  spans.set(event.taskId, { span, name: event.name, kind: event.kind });
}

function recordProgress(span: Span | undefined, event: Extract<TaskEvent, { type: "task:progress" }>): void {
  if (span === undefined) return;
  const attributes: Attributes = {};
  if (event.pct !== undefined) attributes["workit.progress.pct"] = event.pct;
  if (event.message !== undefined) attributes["workit.progress.has_message"] = true;
  const logLevel = extractLogLevel(event.data);
  if (logLevel !== undefined) attributes["workit.log.level"] = logLevel;
  span.addEvent("workit.task.progress", attributes);
}

function recordTaskCleanupFailure(span: Span | undefined, event: Extract<TaskEvent, { type: "task:cleanup_failed" }>): void {
  if (span === undefined) return;
  span.addEvent("workit.task.cleanup_failed", {
    "workit.error.message": errorMessage(event.error),
  });
}

function recordTaskCleanupTimeout(span: Span | undefined, event: Extract<TaskEvent, { type: "task:cleanup_timeout" }>): void {
  if (span === undefined) return;
  span.addEvent("workit.task.cleanup_timeout", {
    "workit.cleanup.timeout_ms": event.timeoutMs,
  });
}

function finishTask(
  taskId: TaskId,
  outcome: "succeeded",
  durationMs: number,
  spans: Map<TaskId, TaskSpanState>,
  taskCounter: CounterLike,
  taskDuration: HistogramLike
): void {
  const state = spans.get(taskId);
  if (state === undefined) return;
  spans.delete(taskId);
  state.span.setStatus({ code: SpanStatusCode.OK });
  recordTaskMetrics(outcome, durationMs, state.kind, taskCounter, taskDuration);
  safeEnd(state.span);
}

function failTask(
  taskId: TaskId,
  error: unknown,
  durationMs: number,
  spans: Map<TaskId, TaskSpanState>,
  taskCounter: CounterLike,
  taskDuration: HistogramLike
): void {
  const state = spans.get(taskId);
  if (state === undefined) return;
  spans.delete(taskId);
  state.span.recordException(toException(error));
  state.span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
  recordTaskMetrics("failed", durationMs, state.kind, taskCounter, taskDuration);
  safeEnd(state.span);
}

function cancelTask(
  taskId: TaskId,
  reason: CancelReason,
  durationMs: number,
  spans: Map<TaskId, TaskSpanState>,
  taskCounter: CounterLike,
  taskDuration: HistogramLike
): void {
  const state = spans.get(taskId);
  if (state === undefined) return;
  spans.delete(taskId);
  state.span.setAttribute("workit.cancel.kind", reason.kind);
  state.span.setStatus({ code: SpanStatusCode.ERROR, message: `cancelled:${reason.kind}` });
  recordTaskMetrics("cancelled", durationMs, state.kind, taskCounter, taskDuration);
  safeEnd(state.span);
}

function recordTaskMetrics(
  outcome: "succeeded" | "failed" | "cancelled",
  durationMs: number,
  kind: TaskKind,
  counter: CounterLike,
  histogram: HistogramLike
): void {
  const labels = {
    "workit.task.kind": kind,
    "workit.task.outcome": outcome,
  };
  counter.add(1, labels);
  histogram.record(durationMs, labels);
}

function recordScopeSummary(
  summary: ScopeSummary,
  counter: CounterLike,
  histogram: HistogramLike
): void {
  const labels = { "workit.scope.outcome": summary.outcome };
  counter.add(1, labels);
  histogram.record(summary.durationMs, labels);
}

function extractLogLevel(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const value = (data as { logLevel?: unknown }).logLevel;
  return typeof value === "string" ? value : undefined;
}

function toException(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeEnd(span: Span): void {
  try {
    span.end();
  } catch {
    // Telemetry errors must never affect application work.
  }
}

interface CounterLike {
  add(value: number, attributes?: Attributes): void;
}

interface HistogramLike {
  record(value: number, attributes?: Attributes): void;
}
