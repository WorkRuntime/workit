/**
 * Replayable lifecycle receipts for WorkIt scopes.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Receipts are audit evidence over existing scope snapshots and typed runtime
 * events. They intentionally do not claim deterministic scheduler replay.
 */

import {
  CancellationError,
  type TaskFn,
  type TaskContext,
  type CancelReason,
  type Scope,
  type ScopeId,
  type ScopeSnapshot,
  type TaskEvent,
  type TaskId,
  type TaskKind,
  type Unsubscribe,
} from "../types/index.js";

/** Receipt schema version emitted by this subpath. */
export type WorkItReceiptVersion = "workit.receipt.v1";

/** Terminal lifecycle outcome inferred from scope closing evidence. */
export type WorkItReceiptOutcome = "completed" | "failed" | "cancelled" | "running";

/** Serializable, bounded error evidence for receipts. */
export interface WorkItReceiptError {
  readonly name: string;
  readonly message: string;
}

/** Normalized receipt event derived from WorkIt's typed engine event stream. */
export interface WorkItReceiptEvent {
  readonly type: TaskEvent["type"];
  readonly at: number;
  readonly taskId?: TaskId;
  readonly scopeId?: ScopeId;
  readonly parentId?: ScopeId | null;
  readonly name?: string;
  readonly kind?: TaskKind;
  readonly attempt?: number;
  readonly startedAt?: number;
  readonly outcome?: WorkItAttemptOutcome;
  readonly nextDelayMs?: number;
  readonly timeoutMs?: number;
  readonly durationMs?: number;
  readonly reason?: CancelReason | "completed" | "errored" | "cancelled";
  readonly error?: WorkItReceiptError;
  readonly message?: string;
  readonly pct?: number;
  readonly data?: unknown;
  readonly droppedTelemetryEvents?: number;
}

/** Aggregate lifecycle counters included in a WorkIt receipt. */
export interface WorkItReceiptSummary {
  readonly totalTasks: number;
  readonly pendingTasks: number;
  readonly completedTasks: number;
  readonly failedTasks: number;
  readonly cancelledTasks: number;
  readonly totalScopes: number;
  readonly pendingScopes: number;
  readonly cleanupFailures: number;
  readonly cleanupTimeouts: number;
  readonly retryEvents: number;
  readonly droppedEvents: number;
  readonly droppedTelemetryEvents: number;
  readonly leakedTasks: number;
}

/** Terminal lifecycle fact recorded by a receipt. */
export interface WorkItReceiptTerminal {
  readonly outcome: WorkItReceiptOutcome;
  readonly at?: number;
  readonly durationMs?: number;
  readonly cancelReason?: CancelReason;
  readonly error?: WorkItReceiptError;
}

/** Terminal outcome of one explicitly recorded task attempt. */
export type WorkItAttemptOutcome = "succeeded" | "failed" | "cancelled";

/** Bounded evidence for one invocation of a retryable task body. */
export interface WorkItAttemptEvidence {
  readonly taskId: TaskId;
  readonly attempt: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly outcome: WorkItAttemptOutcome;
  readonly reasonCode?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly error?: WorkItReceiptError;
}

/** Complete audit receipt for one observed scope tree. */
export interface WorkItReceipt {
  readonly version: WorkItReceiptVersion;
  readonly receiptId: string;
  readonly createdAt: number;
  readonly rootScopeId: ScopeId;
  readonly rootScopeName?: string;
  readonly terminal: WorkItReceiptTerminal;
  readonly summary: WorkItReceiptSummary;
  readonly events: readonly WorkItReceiptEvent[];
  readonly attempts?: readonly WorkItAttemptEvidence[];
  readonly snapshot: ScopeSnapshot;
  readonly limitations: readonly string[];
}

/** Field-level redaction policy for receipts before storage or publication. */
export interface ReceiptRedactionPolicy {
  readonly removeFields?: readonly string[];
  readonly redactFields?: readonly string[];
  readonly maxDepth?: number;
}

/** Options shared by receipt builders and recorders. */
export interface ReceiptBuildOptions {
  readonly receiptId?: string;
  readonly clock?: () => number;
  readonly redaction?: ReceiptRedactionPolicy;
  readonly limitations?: readonly string[];
  readonly attempts?: readonly WorkItAttemptEvidence[];
}

/** Recorder options for live scope observation. */
export interface ReceiptRecorderOptions extends ReceiptBuildOptions {
  readonly maxEvents?: number;
}

/** Live recorder attached to a WorkIt scope's event stream. */
export interface ReceiptRecorder {
  readonly events: readonly TaskEvent[];
  readonly droppedEvents: number;
  build(snapshot?: ScopeSnapshot, opts?: ReceiptBuildOptions): WorkItReceipt;
  unsubscribe(): void;
}

/** Options shared by all attempts captured by one recorder. */
export interface AttemptRecorderOptions {
  readonly clock?: () => number;
  readonly maxAttempts?: number;
  readonly maxMetadataBytes?: number;
}

/** Per-task evidence policy applied by an attempt recorder. */
export interface AttemptEvidenceOptions {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reasonCode?: (error: unknown, ctx: TaskContext) => string | undefined;
}

/** Bounded recorder for explicit task-attempt evidence. */
export interface AttemptRecorder {
  readonly attempts: readonly WorkItAttemptEvidence[];
  readonly droppedAttempts: number;
  wrap<T>(task: TaskFn<T>, opts?: AttemptEvidenceOptions): TaskFn<T>;
}

interface InternalReceiptBuildOptions extends ReceiptBuildOptions {
  readonly droppedEvents?: number;
}

const RECEIPT_VERSION: WorkItReceiptVersion = "workit.receipt.v1";
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_LIMITATIONS = [
  "receipt_replay_is_audit_evidence_not_deterministic_scheduler_replay",
] as const;
const DEFAULT_REDACT_FIELDS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "apiKey",
  "accessToken",
  "refreshToken",
] as const;
const DEFAULT_MAX_REDACTION_DEPTH = 8;
const DEFAULT_MAX_ATTEMPTS = 10_000;
const DEFAULT_MAX_ATTEMPT_METADATA_BYTES = 4_096;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;

/** Attaches a bounded receipt recorder to a live scope event stream. */
export function createReceiptRecorder(scope: Scope, opts: ReceiptRecorderOptions = {}): ReceiptRecorder {
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new RangeError("maxEvents must be a positive integer");

  const events: TaskEvent[] = [];
  let droppedEvents = 0;
  const unsubscribe: Unsubscribe = scope.onEvent((event) => {
    if (events.length < maxEvents) events.push(event);
    else droppedEvents++;
  });

  return {
    get events() {
      return [...events];
    },
    get droppedEvents() {
      return droppedEvents;
    },
    build(snapshot = scope.status(), buildOpts = {}) {
      return buildReceipt(events, snapshot, {
        ...opts,
        ...buildOpts,
        droppedEvents,
      } as InternalReceiptBuildOptions);
    },
    unsubscribe,
  };
}

/** Creates a bounded recorder that captures actual invocations of wrapped task bodies. */
export function createAttemptRecorder(opts: AttemptRecorderOptions = {}): AttemptRecorder {
  const clock = opts.clock ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxMetadataBytes = opts.maxMetadataBytes ?? DEFAULT_MAX_ATTEMPT_METADATA_BYTES;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");
  if (!Number.isInteger(maxMetadataBytes) || maxMetadataBytes < 1) {
    throw new RangeError("maxMetadataBytes must be a positive integer");
  }

  const attempts: WorkItAttemptEvidence[] = [];
  let droppedAttempts = 0;
  return {
    get attempts() { return attempts.map((attempt) => structuredClone(attempt)); },
    get droppedAttempts() { return droppedAttempts; },
    wrap<T>(task: TaskFn<T>, attemptOpts: AttemptEvidenceOptions = {}): TaskFn<T> {
      const metadata = normalizeAttemptMetadata(attemptOpts.metadata, maxMetadataBytes);
      return async (ctx) => {
        const startedAt = clock();
        try {
          const value = await task(ctx);
          record("succeeded", ctx, startedAt);
          return value;
        } catch (error) {
          record(error instanceof CancellationError ? "cancelled" : "failed", ctx, startedAt, error);
          throw error;
        }
      };

      function record(
        outcome: WorkItAttemptOutcome,
        ctx: TaskContext,
        startedAt: number,
        error?: unknown,
      ): void {
        if (attempts.length >= maxAttempts) {
          droppedAttempts++;
          return;
        }
        const completedAt = clock();
        const reasonCode = error === undefined
          ? undefined
          : readAttemptReasonCode(attemptOpts.reasonCode, error, ctx);
        attempts.push({
          taskId: ctx.id,
          attempt: ctx.attempt,
          startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt),
          outcome,
          ...(reasonCode !== undefined ? { reasonCode } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(error !== undefined ? { error: normalizeError(error) } : {}),
        });
      }
    },
  };
}

/** Builds a replayable audit receipt from existing typed events and a snapshot. */
export function buildReceipt(
  events: readonly TaskEvent[],
  snapshot: ScopeSnapshot,
  opts: ReceiptBuildOptions = {},
): WorkItReceipt {
  const internalOpts = opts as InternalReceiptBuildOptions;
  const createdAt = opts.clock?.() ?? Date.now();
  const receiptId = opts.receiptId ?? `receipt:${snapshot.id}:${createdAt}`;
  const normalizedEvents = events.map(normalizeEvent);
  const attempts = opts.attempts ?? attemptsFromEvents(normalizedEvents);
  const summary = summarizeReceipt(snapshot, normalizedEvents, internalOpts.droppedEvents ?? 0);
  const terminal = inferTerminal(snapshot, normalizedEvents);
  const limitations = [
    ...DEFAULT_LIMITATIONS,
    ...(summary.droppedEvents > 0 ? ["receipt_event_window_truncated"] : []),
    ...(opts.limitations ?? []),
  ];
  const receipt: WorkItReceipt = {
    version: RECEIPT_VERSION,
    receiptId,
    createdAt,
    rootScopeId: snapshot.id,
    terminal,
    summary,
    events: normalizedEvents,
    ...(opts.attempts !== undefined || attempts.length > 0
      ? { attempts: attempts.map((attempt) => ({ ...attempt })) }
      : {}),
    snapshot,
    limitations,
    ...(snapshot.name !== undefined ? { rootScopeName: snapshot.name } : {}),
  };

  return redactReceipt(receipt, opts.redaction);
}

function readAttemptReasonCode(
  classify: AttemptEvidenceOptions["reasonCode"],
  error: unknown,
  ctx: TaskContext,
): string | undefined {
  try {
    const reasonCode = classify?.(error, ctx);
    return typeof reasonCode === "string"
      && REASON_CODE_PATTERN.test(reasonCode)
      ? reasonCode
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAttemptMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  maxBytes: number,
): Readonly<Record<string, unknown>> | undefined {
  if (metadata === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    throw new TypeError("attempt metadata must be JSON serializable");
  }
  if (serialized === undefined) throw new TypeError("attempt metadata must serialize to a JSON object");
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new RangeError("attempt metadata exceeds maxMetadataBytes");
  }
  const value = JSON.parse(serialized) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("attempt metadata must serialize to a JSON object");
  }
  return redactValue(value, {
    removeFields: new Set(),
    redactFields: new Set(DEFAULT_REDACT_FIELDS.map((field) => field.toLowerCase())),
    maxDepth: DEFAULT_MAX_REDACTION_DEPTH,
  }, 0) as Readonly<Record<string, unknown>>;
}

/** Applies field-level redaction to an existing receipt. */
export function redactReceipt(receipt: WorkItReceipt, policy: ReceiptRedactionPolicy = {}): WorkItReceipt {
  const removeFields = new Set((policy.removeFields ?? []).map((field) => field.toLowerCase()));
  const redactFields = new Set([
    ...DEFAULT_REDACT_FIELDS.map((field) => field.toLowerCase()),
    ...(policy.redactFields ?? []).map((field) => field.toLowerCase()),
  ]);
  const maxDepth = policy.maxDepth ?? DEFAULT_MAX_REDACTION_DEPTH;

  return redactValue(receipt, { removeFields, redactFields, maxDepth }, 0) as WorkItReceipt;
}

function normalizeEvent(event: TaskEvent): WorkItReceiptEvent {
  switch (event.type) {
    case "task:started":
      return {
        type: event.type,
        taskId: event.taskId,
        scopeId: event.scopeId,
        name: event.name,
        kind: event.kind,
        at: event.at,
      };
    case "task:attempt":
      return {
        type: event.type,
        taskId: event.taskId,
        attempt: event.attempt,
        startedAt: event.at - event.durationMs,
        durationMs: event.durationMs,
        outcome: event.outcome,
        at: event.at,
      };
    case "task:retrying":
      return {
        type: event.type,
        taskId: event.taskId,
        attempt: event.attempt,
        error: normalizeError(event.error),
        nextDelayMs: event.nextDelayMs,
        at: event.at,
      };
    case "task:progress":
      return {
        type: event.type,
        taskId: event.taskId,
        at: event.at,
        ...(event.pct !== undefined ? { pct: event.pct } : {}),
        ...(event.message !== undefined ? { message: event.message } : {}),
        ...(event.data !== undefined ? { data: event.data } : {}),
      };
    case "task:cleanup_failed":
      return {
        type: event.type,
        taskId: event.taskId,
        error: normalizeError(event.error),
        at: event.at,
      };
    case "task:cleanup_timeout":
      return {
        type: event.type,
        taskId: event.taskId,
        timeoutMs: event.timeoutMs,
        at: event.at,
      };
    case "task:succeeded":
      return {
        type: event.type,
        taskId: event.taskId,
        durationMs: event.durationMs,
        at: event.at,
      };
    case "task:failed":
      return {
        type: event.type,
        taskId: event.taskId,
        error: normalizeError(event.error),
        durationMs: event.durationMs,
        at: event.at,
      };
    case "task:cancelled":
      return {
        type: event.type,
        taskId: event.taskId,
        reason: normalizeCancelReason(event.reason),
        durationMs: event.durationMs,
        at: event.at,
      };
    case "scope:opened":
      return {
        type: event.type,
        scopeId: event.scopeId,
        parentId: event.parentId,
        at: event.at,
      };
    case "scope:cleanup_failed":
      return {
        type: event.type,
        scopeId: event.scopeId,
        error: normalizeError(event.error),
        at: event.at,
      };
    case "scope:cleanup_timeout":
      return {
        type: event.type,
        scopeId: event.scopeId,
        timeoutMs: event.timeoutMs,
        at: event.at,
      };
    case "scope:closing":
      return {
        type: event.type,
        scopeId: event.scopeId,
        reason: event.reason,
        at: event.at,
      };
    case "scope:closed":
      return {
        type: event.type,
        scopeId: event.scopeId,
        durationMs: event.durationMs,
        at: event.at,
        ...(event.droppedTelemetryEvents !== undefined
          ? { droppedTelemetryEvents: event.droppedTelemetryEvents }
          : {}),
      };
  }
}

function attemptsFromEvents(events: readonly WorkItReceiptEvent[]): WorkItAttemptEvidence[] {
  return events.flatMap((event) => event.type === "task:attempt"
    && event.taskId !== undefined
    && event.attempt !== undefined
    && event.startedAt !== undefined
    && event.durationMs !== undefined
    && event.outcome !== undefined
    ? [{
        taskId: event.taskId,
        attempt: event.attempt,
        startedAt: event.startedAt,
        completedAt: event.at,
        durationMs: event.durationMs,
        outcome: event.outcome,
      }]
    : []);
}

function summarizeReceipt(
  snapshot: ScopeSnapshot,
  events: readonly WorkItReceiptEvent[],
  droppedEvents: number,
): WorkItReceiptSummary {
  const snapshotCounts = countSnapshot(snapshot);
  const cleanupFailures = events.filter((event) =>
    event.type === "task:cleanup_failed" || event.type === "scope:cleanup_failed"
  ).length;
  const cleanupTimeouts = events.filter((event) =>
    event.type === "task:cleanup_timeout" || event.type === "scope:cleanup_timeout"
  ).length;
  const retryEvents = events.filter((event) => event.type === "task:retrying").length;
  const droppedTelemetryEvents = events.reduce((total, event) =>
    total + (event.droppedTelemetryEvents ?? 0), 0);

  return {
    ...snapshotCounts,
    cleanupFailures,
    cleanupTimeouts,
    retryEvents,
    droppedEvents,
    droppedTelemetryEvents,
    leakedTasks: snapshotCounts.pendingTasks,
  };
}

function countSnapshot(snapshot: ScopeSnapshot): Omit<
  WorkItReceiptSummary,
  "cleanupFailures" | "cleanupTimeouts" | "retryEvents" | "droppedEvents" | "droppedTelemetryEvents" | "leakedTasks"
> {
  const childCounts = snapshot.scopes.reduce((total, child) => {
    const childResult = countSnapshot(child);
    return {
      totalTasks: total.totalTasks + childResult.totalTasks,
      pendingTasks: total.pendingTasks + childResult.pendingTasks,
      completedTasks: total.completedTasks + childResult.completedTasks,
      failedTasks: total.failedTasks + childResult.failedTasks,
      cancelledTasks: total.cancelledTasks + childResult.cancelledTasks,
      totalScopes: total.totalScopes + childResult.totalScopes,
      pendingScopes: total.pendingScopes + childResult.pendingScopes,
    };
  }, {
    totalTasks: snapshot.tasks.length,
    pendingTasks: snapshot.pendingCount,
    completedTasks: snapshot.completedCount,
    failedTasks: snapshot.failedCount,
    cancelledTasks: snapshot.cancelledCount,
    totalScopes: 1,
    pendingScopes: snapshot.status === "closed" ? 0 : 1,
  });

  return childCounts;
}

function inferTerminal(snapshot: ScopeSnapshot, events: readonly WorkItReceiptEvent[]): WorkItReceiptTerminal {
  const rootEvents = events.filter((event) => event.scopeId === snapshot.id);
  const closing = findLast(rootEvents, (event) => event.type === "scope:closing");
  const closed = findLast(rootEvents, (event) => event.type === "scope:closed");
  const lastCancelled = findLast(events, (event) => event.type === "task:cancelled");
  const lastFailed = findLast(events, (event) =>
    event.type === "task:failed" || event.type === "scope:cleanup_failed" || event.type === "task:cleanup_failed"
  );
  const base = {
    ...(closed?.at !== undefined ? { at: closed.at } : closing?.at !== undefined ? { at: closing.at } : {}),
    ...(closed?.durationMs !== undefined ? { durationMs: closed.durationMs } : {}),
  };

  if (closing?.reason === "cancelled") {
    return {
      outcome: "cancelled",
      ...base,
      ...(isCancelReason(lastCancelled?.reason) ? { cancelReason: lastCancelled.reason } : {}),
    };
  }

  if (closing?.reason === "errored" || snapshot.failedCount > 0) {
    return {
      outcome: "failed",
      ...base,
      ...(lastFailed?.error !== undefined ? { error: lastFailed.error } : {}),
    };
  }

  if (closing?.reason === "completed" || snapshot.status === "closed") {
    return {
      outcome: "completed",
      ...base,
    };
  }

  return { outcome: "running" };
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return undefined;
}

function normalizeCancelReason(reason: CancelReason): CancelReason {
  switch (reason.kind) {
    case "parent_failed":
      return { kind: "parent_failed", error: normalizeError(reason.error) };
    case "sibling_failed":
      return { kind: "sibling_failed", siblingId: reason.siblingId, error: normalizeError(reason.error) };
    case "manual":
      return {
        kind: "manual",
        tag: reason.tag,
        ...(reason.data !== undefined ? { data: reason.data } : {}),
      };
    default:
      return reason;
  }
}

function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

function normalizeError(error: unknown): WorkItReceiptError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === "string") {
    return { name: "Error", message: error };
  }
  return { name: "UnknownError", message: safeString(error) };
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

interface RedactionRuntimePolicy {
  readonly removeFields: ReadonlySet<string>;
  readonly redactFields: ReadonlySet<string>;
  readonly maxDepth: number;
}

function redactValue(value: unknown, policy: RedactionRuntimePolicy, depth: number): unknown {
  if (depth > policy.maxDepth) return "[max-depth]";
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return normalizeError(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, policy, depth + 1));

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    const normalizedKey = key.toLowerCase();
    if (policy.removeFields.has(normalizedKey)) continue;
    const redactedItem = policy.redactFields.has(normalizedKey)
      ? "[redacted]"
      : redactValue(item, policy, depth + 1);
    Object.defineProperty(output, key, {
      value: redactedItem,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}
