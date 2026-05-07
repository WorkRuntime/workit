/**
 * Opt-in observability export helpers for WorkJS.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Core WorkJS never imports remote telemetry clients. This module accepts a
 * caller-provided exporter and adds sampling plus a circuit breaker so telemetry
 * volume and exporter failures cannot take down application work.
 */

import type { Scope, TaskEvent, Unsubscribe } from "../types/index.js";

/** Export destination supplied by an application or companion package. */
export type TaskEventExporter = (event: TaskEvent) => void | Promise<void>;

/** Redacts or drops an event before it leaves the process. */
export type TaskEventSanitizer = (event: TaskEvent) => TaskEvent | undefined;

/** Export destination for one closed scope summary. */
export type ScopeSummaryExporter = (summary: ScopeSummary) => void | Promise<void>;

/** Export destination for cardinality-safe metric points. */
export type MetricExporter = (metric: MetricPoint) => void | Promise<void>;

/** Low-cardinality metric point accepted by the safe metric wrapper. */
export interface MetricPoint {
  name: string;
  value: number;
  labels?: Record<string, string | number | boolean>;
  unit?: string;
}

/** Aggregated record emitted once per closed scope. */
export interface ScopeSummary {
  scopeId: string;
  parentId: string | null;
  durationMs: number;
  outcome: "completed" | "errored" | "cancelled";
  taskCounts: {
    started: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    retried: number;
    cleanupFailed: number;
  };
  droppedTelemetryEvents: number;
}

/** Sampling modes supported by the opt-in export bridge. */
export type SamplingPolicy =
  | { mode: "off" }
  | { mode: "all" }
  | { mode: "head"; rate: number; random?: () => number }
  | { mode: "errors_and_slow"; slowThresholdMs: number };

/** Circuit breaker settings for exporter failure isolation. */
export interface ExporterCircuitBreakerOptions {
  failureThreshold?: number;
  openForMs?: number;
  now?: () => number;
}

/** Bounded queue settings for async exporters. */
export interface ExportQueueOptions {
  maxItems?: number;
  maxBytes?: number;
  estimateBytes?: (event: unknown) => number;
}

/** State transition emitted by the exporter circuit breaker. */
export interface ExporterStateChange {
  from: "closed" | "open" | "half_open";
  to: "closed" | "open" | "half_open";
  at: number;
  reason: "failure_threshold" | "reset_elapsed" | "success";
}

/** Options used when attaching an exporter to a scope. */
export interface TelemetryExportOptions {
  sampling?: SamplingPolicy;
  circuitBreaker?: ExporterCircuitBreakerOptions;
  queue?: ExportQueueOptions;
  sanitize?: TaskEventSanitizer;
  onStateChange?: (event: ExporterStateChange) => void;
}

/** Live attachment returned by `attachTelemetryExporter`. */
export interface TelemetryAttachment {
  unsubscribe(): void;
  exportedCount(): number;
  droppedCount(): number;
  queuedCount(): number;
  state(): "closed" | "open" | "half_open";
}

const DROPPED_TELEMETRY_EVENT = Symbol("droppedTelemetryEvent");

/** Attaches a sampled, circuit-broken exporter to a scope event stream. */
export function attachTelemetryExporter(
  scope: Pick<Scope, "onEvent">,
  exporter: TaskEventExporter,
  opts: TelemetryExportOptions = {}
): TelemetryAttachment {
  const sampling = opts.sampling ?? { mode: "errors_and_slow", slowThresholdMs: 2_000 };
  const breaker = createExporterCircuitBreaker(exporter, opts);

  if (sampling.mode === "off") {
    return makeAttachment(() => undefined, breaker);
  }

  const headAccepted = sampling.mode === "head"
    ? (sampling.random ?? Math.random)() < sampling.rate
    : true;

  const unsubscribe = scope.onEvent((event) => {
    const sanitized = sanitizeTaskEvent(event, opts.sanitize, () => breaker.drop());
    if (sanitized === DROPPED_TELEMETRY_EVENT) return;

    if (!shouldExport(sanitized, sampling, headAccepted)) {
      breaker.drop();
      return;
    }
    void breaker.export(sanitized);
  });

  return makeAttachment(unsubscribe, breaker);
}

/** Attaches an aggregated per-scope summary exporter. */
export function attachScopeSummaryExporter(
  scope: Pick<Scope, "onEvent">,
  exporter: ScopeSummaryExporter,
  opts: TelemetryExportOptions = {}
): TelemetryAttachment {
  const summaries = new Map<string, MutableScopeSummary>();
  const taskOwners = new Map<string, string>();
  const breaker = createExporterCircuitBreaker(exporter, opts);
  const unsubscribe = scope.onEvent((event) => {
    const sanitized = sanitizeTaskEvent(event, opts.sanitize, () => breaker.drop());
    if (sanitized === DROPPED_TELEMETRY_EVENT) return;

    ingestSummaryEvent(summaries, taskOwners, sanitized, breaker.droppedCount());
    if (sanitized.type !== "scope:closed") return;
    const summary = summaries.get(sanitized.scopeId);
    if (summary === undefined) return;
    summaries.delete(sanitized.scopeId);
    void breaker.export(toScopeSummary(summary, sanitized.durationMs, breaker.droppedCount()));
  });
  return makeAttachment(unsubscribe, breaker);
}

/** Wraps a metric exporter with a cardinality-safe label guard. */
export function createCardinalitySafeMetricExporter(
  exporter: MetricExporter,
  opts: { allowedLabels?: readonly string[] } = {}
): MetricExporter {
  const allowed = opts.allowedLabels === undefined ? null : new Set(opts.allowedLabels);
  return async (metric) => {
    validateMetric(metric, allowed);
    await exporter(metric);
  };
}

function shouldExport(event: TaskEvent, sampling: SamplingPolicy, headAccepted: boolean): boolean {
  switch (sampling.mode) {
    case "all":
      return true;
    case "head":
      return headAccepted;
    case "errors_and_slow":
      return event.type === "task:failed"
        || event.type === "task:cleanup_failed"
        || event.type === "task:cleanup_timeout"
        || event.type === "scope:cleanup_failed"
        || event.type === "scope:cleanup_timeout"
        || event.type === "task:cancelled"
        || (event.type === "task:succeeded" && event.durationMs >= sampling.slowThresholdMs);
    /* v8 ignore next -- off mode returns before subscribing to scope events. */
    case "off":
      return false;
  }
}

function sanitizeTaskEvent(
  event: TaskEvent,
  sanitize: TaskEventSanitizer | undefined,
  onDrop: () => void
): TaskEvent | typeof DROPPED_TELEMETRY_EVENT {
  if (sanitize === undefined) return event;
  try {
    const sanitized = sanitize(event);
    if (sanitized === undefined) {
      onDrop();
      return DROPPED_TELEMETRY_EVENT;
    }
    return sanitized;
  } catch {
    onDrop();
    return DROPPED_TELEMETRY_EVENT;
  }
}

function createExporterCircuitBreaker<T>(
  exporter: (event: T) => void | Promise<void>,
  opts: TelemetryExportOptions
) {
  const circuit = opts.circuitBreaker ?? {};
  const failureThreshold = circuit.failureThreshold ?? 3;
  const openForMs = circuit.openForMs ?? 60_000;
  const now = circuit.now ?? Date.now;
  const maxQueueItems = opts.queue?.maxItems ?? 1_024;
  const maxQueueBytes = opts.queue?.maxBytes ?? Number.POSITIVE_INFINITY;
  const estimateBytes = opts.queue?.estimateBytes ?? estimateEventBytes;
  let state: "closed" | "open" | "half_open" = "closed";
  let failures = 0;
  let openedUntil = 0;
  let exported = 0;
  let dropped = 0;
  let draining = false;
  let queuedBytes = 0;
  const queue: Array<{ event: T; bytes: number }> = [];

  return {
    async export(event: T): Promise<void> {
      const bytes = estimateBytes(event);
      if (maxQueueItems < 1 || maxQueueBytes < 1 || bytes > maxQueueBytes) {
        dropped++;
        return;
      }

      if (queue.length >= maxQueueItems) {
        const droppedItem = queue.shift();
        /* v8 ignore else -- queue length check guarantees one item. */
        if (droppedItem !== undefined) queuedBytes -= droppedItem.bytes;
        dropped++;
      }
      while (queuedBytes + bytes > maxQueueBytes && queue.length > 0) {
        const droppedItem = queue.shift();
        /* v8 ignore else -- queue length check guarantees one item. */
        if (droppedItem !== undefined) queuedBytes -= droppedItem.bytes;
        dropped++;
      }
      queue.push({ event, bytes });
      queuedBytes += bytes;
      await drain();
    },
    drop(): void {
      dropped++;
    },
    exportedCount(): number {
      return exported;
    },
    droppedCount(): number {
      return dropped;
    },
    queuedCount(): number {
      return queue.length;
    },
    state(): "closed" | "open" | "half_open" {
      return state;
    },
  };

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        /* v8 ignore next -- guarded by queue length. */
        if (item === undefined) continue;
        queuedBytes -= item.bytes;
        await exportOne(item.event);
      }
    } finally {
      draining = false;
    }
  }

  async function exportOne(event: T): Promise<void> {
    if (state === "open") {
      if (now() < openedUntil) {
        dropped++;
        return;
      }
      transition("half_open", "reset_elapsed");
    }

    try {
      await exporter(event);
      exported++;
      failures = 0;
      if (state === "half_open") transition("closed", "success");
      else state = "closed";
    } catch {
      dropped++;
      failures++;
      if (state === "half_open" || failures >= failureThreshold) {
        transition("open", "failure_threshold");
        openedUntil = now() + openForMs;
      }
    }
  }

  function transition(to: "closed" | "open" | "half_open", reason: ExporterStateChange["reason"]): void {
    /* v8 ignore if -- callers only request real state transitions. */
    if (state === to) return;
    const from = state;
    state = to;
    opts.onStateChange?.({ from, to, at: now(), reason });
  }
}

interface MutableScopeSummary {
  scopeId: string;
  parentId: string | null;
  outcome: "completed" | "errored" | "cancelled";
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  retried: number;
  cleanupFailed: number;
  droppedTelemetryEvents: number;
}

function ingestSummaryEvent(
  summaries: Map<string, MutableScopeSummary>,
  taskOwners: Map<string, string>,
  event: TaskEvent,
  droppedTelemetryEvents: number
): void {
  if (event.type === "scope:opened") {
    summaries.set(event.scopeId, {
      scopeId: event.scopeId,
      parentId: event.parentId,
      outcome: "completed",
      started: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      retried: 0,
      cleanupFailed: 0,
      droppedTelemetryEvents,
    });
    return;
  }

  if (event.type === "task:started") taskOwners.set(event.taskId, event.scopeId);

  const summary = findEventSummary(summaries, taskOwners, event);
  if (summary === undefined) return;
  summary.droppedTelemetryEvents = Math.max(summary.droppedTelemetryEvents, droppedTelemetryEvents);

  switch (event.type) {
    case "task:started":
      summary.started++;
      break;
    case "task:succeeded":
      summary.succeeded++;
      break;
    case "task:failed":
      summary.failed++;
      summary.outcome = "errored";
      break;
    case "task:cleanup_failed":
    case "task:cleanup_timeout":
    case "scope:cleanup_failed":
    case "scope:cleanup_timeout":
      summary.cleanupFailed++;
      summary.outcome = "errored";
      break;
    case "task:cancelled":
      summary.cancelled++;
      if (summary.outcome !== "errored") summary.outcome = "cancelled";
      break;
    case "task:retrying":
      summary.retried++;
      break;
    case "scope:closing":
      if (summary.outcome !== "errored") {
        summary.outcome = event.reason === "errored" ? "errored" : event.reason;
      }
      break;
    case "scope:closed":
      summary.droppedTelemetryEvents = Math.max(
        summary.droppedTelemetryEvents,
        event.droppedTelemetryEvents ?? 0
      );
      break;
    case "task:progress":
      break;
  }
}

function findEventSummary(
  summaries: Map<string, MutableScopeSummary>,
  taskOwners: Map<string, string>,
  event: TaskEvent
): MutableScopeSummary | undefined {
  if ("scopeId" in event) return summaries.get(event.scopeId);
  /* v8 ignore else -- every remaining task event has a task id by contract. */
  if ("taskId" in event) {
    const scopeId = taskOwners.get(event.taskId);
    if (scopeId !== undefined) return summaries.get(scopeId);
  }
  return undefined;
}

function toScopeSummary(
  summary: MutableScopeSummary,
  durationMs: number,
  droppedTelemetryEvents: number
): ScopeSummary {
  const totalDroppedTelemetryEvents = Math.max(summary.droppedTelemetryEvents, droppedTelemetryEvents);
  return {
    scopeId: summary.scopeId,
    parentId: summary.parentId,
    durationMs,
    outcome: summary.outcome,
    taskCounts: {
      started: summary.started,
      succeeded: summary.succeeded,
      failed: summary.failed,
      cancelled: summary.cancelled,
      retried: summary.retried,
      cleanupFailed: summary.cleanupFailed,
    },
    droppedTelemetryEvents: totalDroppedTelemetryEvents,
  };
}

function estimateEventBytes(event: unknown): number {
  try {
    return JSON.stringify(event)?.length ?? 0;
  } catch {
    return 1_024;
  }
}

const FORBIDDEN_LABELS = new Set([
  "id",
  "taskId",
  "scopeId",
  "requestId",
  "traceId",
  "spanId",
  "messageId",
  "providerRequestId",
  "url",
  "filename",
  "path",
  "userText",
]);

function validateMetric(metric: MetricPoint, allowed: Set<string> | null): void {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/.test(metric.name)) {
    throw new Error(`Invalid metric name "${metric.name}"`);
  }
  if (!Number.isFinite(metric.value)) {
    throw new Error(`Metric "${metric.name}" requires a finite numeric value`);
  }
  for (const [key, value] of Object.entries(metric.labels ?? {})) {
    if (FORBIDDEN_LABELS.has(key) || key.endsWith("Id")) {
      throw new Error(`Metric label "${key}" is not cardinality-safe`);
    }
    if (allowed !== null && !allowed.has(key)) {
      throw new Error(`Metric label "${key}" is not in the allowed label set`);
    }
    if (typeof value === "string" && value.length > 64) {
      throw new Error(`Metric label "${key}" value is too long`);
    }
    if (key === "taskKind" && value !== "io" && value !== "llm" && value !== "tool" && value !== "cpu" && value !== "custom") {
      throw new Error(`Metric label "${key}" value "${String(value)}" is not bounded`);
    }
  }
}

function makeAttachment(
  unsubscribe: Unsubscribe,
  breaker: ReturnType<typeof createExporterCircuitBreaker>
): TelemetryAttachment {
  return {
    unsubscribe,
    exportedCount: () => breaker.exportedCount(),
    droppedCount: () => breaker.droppedCount(),
    queuedCount: () => breaker.queuedCount(),
    state: () => breaker.state(),
  };
}
