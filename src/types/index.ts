/**
 * WorkJS - Public Types
 *
 * @author Admilson B. F. Cossa
 *
 * The complete public type surface. See `doc.md` section 3 and `doc-extensions.md` section 2, section 8.
 * Every type here is normative; implementations must match these signatures exactly.
 */

// --- Branded identifiers --------------------------------------------------

/** Opaque task identifier used for correlation and snapshots, not metric labels. */
export type TaskId = string & { readonly __brand: "TaskId" };

/** Opaque scope identifier used for correlation and snapshots, not metric labels. */
export type ScopeId = string & { readonly __brand: "ScopeId" };

// --- Duration -------------------------------------------------------------

/** Parseable duration string accepted by timeout and deadline APIs. */
export type DurationString = `${number}${"ms" | "s" | "m" | "h"}`;

/** Duration in milliseconds or as a strict unit-suffixed string. */
export type Duration = DurationString | number;

// --- Task kinds -----------------------------------------------------------

/** Bounded task category used for routing, snapshots, and cardinality-safe metrics. */
export type TaskKind = "io" | "llm" | "tool" | "cpu" | "custom";

// --- Cancellation reason (discriminated union) ----------------------------

/** Typed reason explaining why a task or scope was cancelled. */
export type CancelReason =
  | { kind: "user"; message?: string }
  | { kind: "deadline"; deadlineAt: number; elapsedMs: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "parent_failed"; error: unknown }
  | { kind: "sibling_failed"; siblingId: TaskId; error: unknown }
  | { kind: "race_lost"; winnerId: TaskId }
  | { kind: "budget"; budgetKey: string; limit: number; spent: number }
  | { kind: "scope_ended" }
  | { kind: "manual"; tag: string; data?: unknown };

// --- Errors ---------------------------------------------------------------

/** Error thrown when work observes a structured cancellation reason. */
export class CancellationError extends Error {
  readonly reason: CancelReason;
  constructor(reason: CancelReason) {
    super(`Cancelled: ${reason.kind}`);
    this.name = "CancellationError";
    this.reason = reason;
  }
}

/** Cancellation error raised by timeout policies. */
export class TimeoutError extends CancellationError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super({ kind: "timeout", timeoutMs });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Budget cancellation error raised when a cooperative budget charge exceeds its limit. */
export class BudgetExceededError extends CancellationError {
  readonly budgetKey: string;
  readonly limit: number;
  readonly spent: number;
  readonly attempted: number;
  readonly unit?: string;
  constructor(opts: {
    budgetKey: string;
    limit: number;
    spent: number;
    attempted: number;
    unit?: string;
  }) {
    super({ kind: "budget", budgetKey: opts.budgetKey, limit: opts.limit, spent: opts.spent });
    this.name = "BudgetExceededError";
    this.budgetKey = opts.budgetKey;
    this.limit = opts.limit;
    this.spent = opts.spent;
    this.attempted = opts.attempted;
    if (opts.unit !== undefined) this.unit = opts.unit;
  }
}

// --- Settlement outcome ---------------------------------------------------

/** Exhaustive settlement result for APIs that collect success, failure, and cancellation. */
export type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "cancelled"; reason: CancelReason };

// --- Progress reports -----------------------------------------------------

/** Optional progress payload emitted by task bodies through `TaskContext.report`. */
export interface ProgressReport {
  pct?: number;
  message?: string;
  data?: unknown;
}

/** Cardinality-safe task logger that emits through WorkJS events, never console. */
export interface TaskLogger {
  /** Emits low-priority diagnostic detail for subscribed observers. */
  debug(message: string, fields?: Record<string, unknown>): void;

  /** Emits normal task activity detail for subscribed observers. */
  info(message: string, fields?: Record<string, unknown>): void;

  /** Emits degraded-but-continuing task detail for subscribed observers. */
  warn(message: string, fields?: Record<string, unknown>): void;

  /** Emits task-local failure detail for subscribed observers. */
  error(message: string, fields?: Record<string, unknown>): void;
}

// --- Event bus types ------------------------------------------------------

/** Typed event stream emitted by the engine at task and scope boundaries. */
export type TaskEvent =
  | { type: "task:started"; taskId: TaskId; scopeId: ScopeId; name: string; kind: TaskKind; at: number }
  | { type: "task:retrying"; taskId: TaskId; attempt: number; error: unknown; nextDelayMs: number; at: number }
  | { type: "task:progress"; taskId: TaskId; pct?: number; message?: string; data?: unknown; at: number }
  | { type: "task:succeeded"; taskId: TaskId; durationMs: number; at: number }
  | { type: "task:failed"; taskId: TaskId; error: unknown; durationMs: number; at: number }
  | { type: "task:cancelled"; taskId: TaskId; reason: CancelReason; durationMs: number; at: number }
  | { type: "scope:opened"; scopeId: ScopeId; parentId: ScopeId | null; at: number }
  | { type: "scope:closing"; scopeId: ScopeId; reason: "completed" | "errored" | "cancelled"; at: number }
  | { type: "scope:closed"; scopeId: ScopeId; durationMs: number; at: number };

/** Removes a previously registered event or cancellation handler. */
export type Unsubscribe = () => void;

// --- Context (DI) ---------------------------------------------------------

/** Typed key used to store immutable scope context values. */
export interface ContextKey<T> {
  readonly __brand: "ContextKey";
  readonly __type: T;
  readonly name: string;
  readonly defaultValue?: T;
  /** Optional default unit used by budget keys when a budget state has no unit. */
  readonly unit?: string;
}

/** Immutable context bag passed through scope and task execution. */
export interface ContextBag {
  /** Returns the stored value, the key default, or `undefined` when absent. */
  get<T>(key: ContextKey<T>): T | undefined;

  /** Returns the value or fails at the boundary where the missing contract is detected. */
  getOrThrow<T>(key: ContextKey<T>): T;

  /** Returns a new context bag with one key overridden. */
  with<T>(key: ContextKey<T>, value: T): ContextBag;

  /** Reports whether the key is explicitly present in this bag. */
  has<T>(key: ContextKey<T>): boolean;
}

// --- Budget state (used by section 2 budgets and section 8 telemetry budget) -----------

/** Mutable cooperative budget state stored in a scope context. */
export interface BudgetState {
  limit: number;
  spent: number;
  unit?: string;
}

// --- Task function and context --------------------------------------------

/** Function executed inside exactly one WorkJS task context. */
export type TaskFn<T> = (ctx: TaskContext) => Promise<T>;

/** Runtime contract exposed to a task body. */
export interface TaskContext {
  /** Abort signal linked to the owning scope and this task handle. */
  readonly signal: AbortSignal;

  /** Scope that owns the task. */
  readonly scope: Scope;

  /** Current attempt number, one-indexed. The current engine sets this to 1. */
  readonly attempt: number;

  /** Stable task identifier for snapshots and trace records. */
  readonly id: TaskId;

  /** Bounded task name chosen by code, safe for summaries when kept low-cardinality. */
  readonly name: string;

  /** Bounded task kind. */
  readonly kind: TaskKind;

  /** Immutable scope context visible to this task. */
  readonly context: ContextBag;

  /** Emits cardinality-safe task log events through the owning scope's event bus. */
  readonly log: TaskLogger;

  /** Registers cleanup that runs in LIFO order when the task settles. */
  defer(cleanup: () => void | Promise<void>): void;

  /** Emits a task progress event without changing task state. */
  report(progress: ProgressReport): void;

  /** Charges the built-in CostBudget and cancels the owning scope if exceeded. */
  consumeCost(amount: number): void;

  /** Charges a custom budget key and cancels that budget's owning scope if exceeded. */
  consume<T extends BudgetState>(key: ContextKey<T>, amount: number): void;

  /** Returns active budget states visible to this task. */
  budgets(): ReadonlyArray<{ key: string; state: BudgetState }>;
}

// --- Task handle (Promise + control surface) -----------------------------

/** Promise-like task handle with status, cancellation, and correlation fields. */
export interface TaskHandle<T> extends Promise<T> {
  readonly id: TaskId;
  readonly name: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  readonly signal: AbortSignal;
  cancel(reason?: CancelReason | string): void;
}

// --- Snapshots (for status() and tree()) ---------------------------------

/** Point-in-time task state returned by `Scope.status()`. */
export interface TaskSnapshot {
  id: TaskId;
  name: string;
  kind: TaskKind;
  status: TaskHandle<unknown>["status"];
  attempt: number;
  startedAt: number;
  durationMs?: number;
  progress?: ProgressReport;
  meta?: Record<string, unknown>;
}

/** Point-in-time scope tree state returned by `Scope.status()`. */
export interface ScopeSnapshot {
  id: ScopeId;
  name?: string;
  status: "running" | "cancelling" | "closed";
  startedAt: number;
  deadlineAt?: number;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  tasks: TaskSnapshot[];
  scopes: ScopeSnapshot[];
}

// --- Task options ---------------------------------------------------------

/** Options used when spawning a task. */
export interface TaskOpts {
  name?: string;
  kind?: TaskKind;
  meta?: Record<string, unknown>;
}

// --- Scope options --------------------------------------------------------

/** Options used when opening a scope. */
export interface ScopeOpts {
  name?: string;
  deadline?: Duration;
  context?: ContextBag;
}

// --- The Scope interface (engine surface) --------------------------------

/** Structured concurrency boundary that owns child tasks, context, cleanup, and events. */
export interface Scope {
  readonly id: ScopeId;
  readonly signal: AbortSignal;
  readonly context: ContextBag;
  readonly parent: Scope | null;
  /** Starts a child task owned by this scope. */
  spawn<T>(task: TaskFn<T>, opts?: TaskOpts): TaskHandle<T>;

  /** Cancels this scope and propagates cancellation through owned children. */
  cancel(reason?: CancelReason | string): void;

  /** Installs a deadline relative to now. */
  deadline(duration: Duration): void;

  /** Registers scope-level cleanup that runs in LIFO order on close. */
  defer(cleanup: () => void | Promise<void>): void;

  /** Returns the current scope tree snapshot. */
  status(): ScopeSnapshot;

  /** Subscribes to task and scope events emitted in this scope tree. */
  onEvent(handler: (e: TaskEvent) => void): Unsubscribe;

  /** Subscribes to this scope's cancellation decision. */
  onCancel(handler: (reason: CancelReason) => void): Unsubscribe;
}

// --- Built-in budget keys (section 2.1, section 8.5) ----------------------------------

/** Built-in budget key for telemetry event volume. */
export const TelemetryBudget: ContextKey<BudgetState> = {
  __brand: "ContextKey",
  __type: undefined as unknown as BudgetState,
  name: "TelemetryBudget",
  unit: "events",
};

/** Built-in budget key for user-defined cost accounting. */
export const CostBudget: ContextKey<BudgetState> = {
  __brand: "ContextKey",
  __type: undefined as unknown as BudgetState,
  name: "CostBudget",
};
