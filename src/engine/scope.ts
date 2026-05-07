/**
 * Scope - the structured concurrency primitive.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Implements the current in-process scope engine: scope ownership, task
 * spawning, cancellation propagation, deadline cancellation, cleanup defers,
 * context propagation, event emission, and cooperative budget consumption.
 *
 * Rules enforced in this file:
 *   R1. Every task runs inside exactly one Scope.
 *   R2. A Scope owns: AbortController, defer[] (LIFO), ContextBag, child set, EventBus.
 *   R3. Cancel: set state=cancelling -> abort signal -> await children -> run defers LIFO -> close.
 *   R4. A Scope cannot close while non-detached children are pending.
 *   R6. background = scoped child. detached = explicit orphan.
 *
 * This file does not implement run.all/race/any; it provides the scope
 * primitive those composition APIs must use.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Scope,
  ScopeId,
  ScopeOpts,
  ScopeSnapshot,
  TaskFn,
  TaskHandle,
  TaskOpts,
  TaskKind,
  TaskId,
  TaskSnapshot,
  TaskEvent,
  CancelReason,
  ContextBag,
  ContextKey,
  BudgetState,
  Duration,
  Unsubscribe,
  TaskLogger,
  CleanupContext,
  CleanupOpts,
} from "../types/index.js";
import { CancellationError, BudgetExceededError, CostBudget, TimeoutError } from "../types/index.js";
import { ContextBagImpl } from "./context.js";
import { EventBus } from "./event-bus.js";
import { parseDuration } from "./duration.js";

// --- ID generation ------------------------------------------------------
let _nextId = 0;
const makeScopeId = (): ScopeId => `scope-${++_nextId}` as ScopeId;
const makeTaskId = (): TaskId => `task-${++_nextId}` as TaskId;
const MAX_TASK_NAME_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_DEFERS_PER_OWNER = 10_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;

interface CleanupRecord {
  readonly cleanup: (ctx: CleanupContext) => void | Promise<void>;
  readonly timeoutMs: number;
}

// --- AsyncLocalStorage for current scope ------------------------------
const currentScope = new AsyncLocalStorage<ScopeImpl>();

/**
 * Returns the scope bound to the current async call chain.
 *
 * A `null` result means execution is outside a WorkJS scope boundary.
 */
export function getCurrentScope(): ScopeImpl | null {
  return currentScope.getStore() ?? null;
}

/** Links multiple abort signals into one signal without changing their owners. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

// --- Internal task record (engine-side mirror of TaskHandle) -----------
interface TaskRecord<T = unknown> {
  id: TaskId;
  name: string;
  kind: TaskKind;
  status: TaskHandle<T>["status"];
  attempt: number;
  startedAt: number;
  endedAt?: number;
  promise: Promise<T>;
  cancel: (reason: CancelReason) => void;
  background: boolean;
  meta?: Record<string, unknown>;
}

// --- ScopeImpl ----------------------------------------------------------

/**
 * Concrete local scope implementation.
 *
 * A scope owns child tasks and child scopes until `close()` drains them. It does
 * not persist receipts or export telemetry; those responsibilities belong to
 * higher-level layers that subscribe to typed events.
 */
export class ScopeImpl implements Scope {
  readonly id: ScopeId = makeScopeId();
  readonly signal: AbortSignal;
  readonly context: ContextBag;
  readonly parent: ScopeImpl | null;
  readonly bus: EventBus;
  readonly name: string | undefined;

  private readonly ownAbort = new AbortController();
  private readonly tasks = new Map<TaskId, TaskRecord>();
  private readonly childScopes = new Set<ScopeImpl>();
  private readonly idempotencyHandles = new Map<string, TaskHandle<unknown>>();
  private readonly defers: CleanupRecord[] = [];
  private readonly cancelHandlers = new Set<(r: CancelReason) => void>();
  private readonly cleanupTimeoutMs: number;
  private state: "running" | "cancelling" | "closed" = "running";
  private readonly startedAt = Date.now();
  private deadlineAt?: number;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private firstChildFailure: unknown = undefined;
  private closingEmitted = false;
  private resolveClosed!: () => void;
  private readonly closedPromise = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  /** Opens a scope under an optional parent and emits `scope:opened`. */
  constructor(parent: ScopeImpl | null, opts: ScopeOpts = {}) {
    this.parent = parent;
    this.context = opts.context ?? parent?.context ?? new ContextBagImpl();
    this.name = opts.name;
    this.cleanupTimeoutMs = opts.cleanupTimeout !== undefined
      ? parseDuration(opts.cleanupTimeout)
      : parent?.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.signal = parent
      ? anySignal([parent.signal, this.ownAbort.signal])
      : this.ownAbort.signal;
    this.bus = new EventBus(parent?.bus ?? null);

    if (parent) parent.childScopes.add(this);
    if (opts.deadline) this.deadline(opts.deadline);

    this.bus.emit(
      { type: "scope:opened", scopeId: this.id, parentId: parent?.id ?? null, at: Date.now() },
      this.context
    );
  }

  // -- R6: spawn a scoped child task ------------------------------------

  /**
   * Starts a child task owned by this scope.
   *
   * The returned handle is both awaitable and cancellable. Task cleanup defers
   * drain in LIFO order after the task body settles.
   */
  spawn<T>(task: TaskFn<T>, opts: TaskOpts = {}, background = false): TaskHandle<T> {
    if (this.state !== "running") {
      throw new Error(`Cannot spawn on a ${this.state} scope`);
    }
    if (opts.name !== undefined) assertBoundedString("task name", opts.name, MAX_TASK_NAME_LENGTH);
    if (opts.idempotencyKey !== undefined) {
      assertBoundedString("idempotency key", opts.idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    }
    if (opts.idempotencyKey !== undefined) {
      const existing = this.idempotencyHandles.get(opts.idempotencyKey);
      if (existing !== undefined) return existing as TaskHandle<T>;
    }
    assertNoTaskPolicyShortcuts(opts);

    const id = makeTaskId();
    const name = opts.name ?? "anonymous";
    const kind = opts.kind ?? "io";
    const startedAt = Date.now();
    const cleanupTimeoutMs = opts.cleanupTimeout !== undefined
      ? parseDuration(opts.cleanupTimeout)
      : this.cleanupTimeoutMs;

    const taskAbort = new AbortController();
    const taskSignal = anySignal([this.signal, taskAbort.signal]);
    const defers: CleanupRecord[] = [];

    const ctx = this.makeTaskContext(id, name, kind, taskSignal, defers, cleanupTimeoutMs);

    const record: TaskRecord<T> = {
      id, name, kind,
      status: "pending",
      attempt: 1,
      startedAt,
      promise: undefined as unknown as Promise<T>,
      cancel: (reason) => taskAbort.abort(new CancellationError(reason)),
      background,
      ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    };
    this.tasks.set(id, record as TaskRecord);

    this.bus.emit(
      { type: "task:started", taskId: id, scopeId: this.id, name, kind, at: startedAt },
      this.context
    );

    const promise = (async () => {
      record.status = "running";
      let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
      let terminalEvent: TaskEvent | undefined;
      try {
        const value = await currentScope.run(this, () => task(ctx));
        record.status = "succeeded";
        record.endedAt = Date.now();
        terminalEvent = { type: "task:succeeded", taskId: id, durationMs: record.endedAt - startedAt, at: record.endedAt };
        outcome = { ok: true, value };
      } catch (err) {
        record.endedAt = Date.now();
        if (err instanceof TimeoutError) {
          record.status = "failed";
          if (!record.background && this.firstChildFailure === undefined) {
            this.firstChildFailure = err;
            this.cancel({ kind: "sibling_failed", siblingId: id, error: err });
          }
          terminalEvent = {
            type: "task:failed",
            taskId: id,
            error: err,
            durationMs: record.endedAt - startedAt,
            at: record.endedAt,
          };
        } else if (err instanceof CancellationError) {
          record.status = "cancelled";
          terminalEvent = {
            type: "task:cancelled",
            taskId: id,
            reason: err.reason,
            durationMs: record.endedAt - startedAt,
            at: record.endedAt,
          };
        } else {
          record.status = "failed";
          if (!record.background && this.firstChildFailure === undefined) {
            this.firstChildFailure = err;
            this.cancel({ kind: "sibling_failed", siblingId: id, error: err });
          }
          terminalEvent = {
            type: "task:failed",
            taskId: id,
            error: err,
            durationMs: record.endedAt - startedAt,
            at: record.endedAt,
          };
        }
        outcome = { ok: false, error: err };
      }

      try {
        // Run defers LIFO; errors logged, never thrown (I5)
        while (defers.length > 0) {
          const record = defers.pop()!;
          try {
            if (await runCleanup(record) === "timed_out") {
              this.bus.emit(
                { type: "task:cleanup_timeout", taskId: id, timeoutMs: record.timeoutMs, at: Date.now() },
                this.context
              );
            }
          } catch (cleanupErr) {
            this.bus.emit(
              { type: "task:cleanup_failed", taskId: id, error: cleanupErr, at: Date.now() },
              this.context
            );
          }
        }
      } finally {
        if (opts.idempotencyKey !== undefined) this.idempotencyHandles.delete(opts.idempotencyKey);
      }

      /* v8 ignore next -- each task execution path assigns a terminal event. */
      if (terminalEvent !== undefined) this.bus.emit(terminalEvent, this.context);
      /* v8 ignore next -- each task execution path assigns an outcome. */
      if (outcome === undefined) throw new Error("Task finished without an outcome");
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    })();

    record.promise = promise;

    // Build the TaskHandle (Promise + control surface)
    const handle = promise as TaskHandle<T>;
    Object.defineProperty(handle, "id", { value: id });
    Object.defineProperty(handle, "name", { value: name });
    Object.defineProperty(handle, "signal", { value: taskSignal });
    Object.defineProperty(handle, "status", { get: () => record.status });
    Object.defineProperty(handle, "cancel", {
      value: (reason: CancelReason | string = "manual") => {
        if (typeof reason === "string") assertBoundedString("manual cancel tag", reason, MAX_TASK_NAME_LENGTH);
        const r: CancelReason = typeof reason === "string" ? { kind: "manual", tag: reason } : reason;
        record.cancel(r);
      },
    });

    if (opts.idempotencyKey !== undefined) this.idempotencyHandles.set(opts.idempotencyKey, handle);

    return handle;
  }

  // -- R3: cancel the scope (synchronous abort, async close) -------------

  /**
   * Marks this scope as cancelling and aborts all linked child work.
   *
   * Cancellation is synchronous; full cleanup happens when `close()` awaits
   * children and drains defers. Repeated cancellation calls after the first are
   * ignored so the first reason remains authoritative for observers.
   */
  cancel(reason: CancelReason | string = "manual"): void {
    if (this.state !== "running") return;
    if (typeof reason === "string") assertBoundedString("manual cancel tag", reason, MAX_TASK_NAME_LENGTH);
    const r: CancelReason = typeof reason === "string" ? { kind: "manual", tag: reason } : reason;
    this.state = "cancelling";
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    try { this.ownAbort.abort(new CancellationError(r)); } catch { /* already aborted */ }
    for (const handler of this.cancelHandlers) {
      try { handler(r); } catch { /* cancel handler errors must not propagate */ }
    }
    this.emitClosing(classifyClosingReason(r));
  }

  /** Installs a relative deadline that cancels this scope when elapsed. */
  deadline(d: Duration): void {
    const ms = parseDuration(d);
    this.deadlineAt = Date.now() + ms;
    this.deadlineTimer = setTimeout(() => {
      this.cancel({
        kind: "deadline",
        deadlineAt: this.deadlineAt!,
        elapsedMs: Date.now() - this.startedAt,
      });
    }, ms);
  }

  /** Registers scope-level cleanup to run in reverse registration order. */
  defer(cleanup: (ctx: CleanupContext) => void | Promise<void>, opts: CleanupOpts = {}): void {
    assertCanAddDefer(this.defers.length);
    this.defers.push({
      cleanup,
      timeoutMs: opts.timeout !== undefined ? parseDuration(opts.timeout) : this.cleanupTimeoutMs,
    });
  }

  /** Subscribes to this scope tree's typed event stream. */
  onEvent(handler: (e: TaskEvent) => void): Unsubscribe {
    return this.bus.on(handler);
  }

  /** Subscribes to this scope's first cancellation decision. */
  onCancel(handler: (reason: CancelReason) => void): Unsubscribe {
    this.cancelHandlers.add(handler);
    return () => this.cancelHandlers.delete(handler);
  }

  /**
   * Closes the scope after all owned work settles.
   *
   * This is the R4 enforcement point: callers do not get a completed scope
   * while child tasks or child scopes remain pending. Cleanup failures are
   * emitted as events and do not prevent the scope from reaching `closed`.
   */
  async close(): Promise<void> {
    // Wait until all task records have settled
    while (this.tasks.size > 0 || this.childScopes.size > 0) {
      const taskPromises = [...this.tasks.values()].map(t =>
        t.promise.catch(() => undefined)
      );
      const scopePromises = [...this.childScopes].map(s => s.awaitClose());
      const all = [...taskPromises, ...scopePromises];
      /* v8 ignore next -- loop condition guarantees at least one pending owner. */
      if (all.length === 0) break;
      await Promise.all(all);
      // Drain: remove settled records
      for (const [id, t] of this.tasks) {
        /* v8 ignore else -- awaited task promises cannot remain pending or running here. */
        if (t.status !== "pending" && t.status !== "running") this.tasks.delete(id);
      }
    }

    // Run defers LIFO, errors logged not thrown (I5)
    while (this.defers.length > 0) {
      const record = this.defers.pop()!;
      try {
        if (await runCleanup(record) === "timed_out") {
          this.bus.emit(
            { type: "scope:cleanup_timeout", scopeId: this.id, timeoutMs: record.timeoutMs, at: Date.now() },
            this.context
          );
        }
      } catch (err) {
        this.bus.emit(
          { type: "scope:cleanup_failed", scopeId: this.id, error: err, at: Date.now() },
          this.context
        );
      }
    }

    if (this.parent) this.parent.childScopes.delete(this);
    this.emitClosing(this.firstChildFailure === undefined ? "completed" : "errored");
    this.state = "closed";
    this.bus.emit(
      {
        type: "scope:closed",
        scopeId: this.id,
        durationMs: Date.now() - this.startedAt,
        droppedTelemetryEvents: this.bus.droppedEventCount(),
        at: Date.now(),
      },
      this.context
    );
    this.resolveClosed();
  }

  /** Waits until this scope reaches `closed` without cancelling it. */
  private async awaitClose(): Promise<void> {
    await this.closedPromise;
  }

  // -- Status snapshot ---------------------------------------------------------

  /** Returns a point-in-time snapshot of this scope and currently retained children. */
  status(): ScopeSnapshot {
    const counts = { pending: 0, completed: 0, failed: 0, cancelled: 0 };
    const statusBuckets = {
      pending: "pending",
      running: "pending",
      succeeded: "completed",
      failed: "failed",
      cancelled: "cancelled",
    } as const;
    const taskSnaps: TaskSnapshot[] = [];
    for (const t of this.tasks.values()) {
      counts[statusBuckets[t.status]]++;

      const snap: TaskSnapshot = {
        id: t.id,
        name: t.name,
        kind: t.kind,
        status: t.status,
        attempt: t.attempt,
        startedAt: t.startedAt,
      };
      if (t.endedAt !== undefined) snap.durationMs = t.endedAt - t.startedAt;
      if (t.meta !== undefined) snap.meta = t.meta;
      taskSnaps.push(snap);
    }

    const snapshot: ScopeSnapshot = {
      id: this.id,
      status: this.state,
      startedAt: this.startedAt,
      pendingCount: counts.pending,
      completedCount: counts.completed,
      failedCount: counts.failed,
      cancelledCount: counts.cancelled,
      tasks: taskSnaps,
      scopes: [...this.childScopes].map(s => s.status()),
    };
    if (this.name !== undefined) snapshot.name = this.name;
    if (this.deadlineAt !== undefined) snapshot.deadlineAt = this.deadlineAt;
    return snapshot;
  }

  // -- Build a TaskContext for a spawned task body ---------------------

  /** Builds the task-facing context object for one spawned task body. */
  private makeTaskContext(
    id: TaskId,
    name: string,
    kind: TaskKind,
    signal: AbortSignal,
    defers: CleanupRecord[],
    cleanupTimeoutMs: number
  ): import("../types/index.js").TaskContext {
    const scope = this;
    const log = makeTaskLogger(scope, id);
    return {
      signal,
      scope,
      attempt: 1,
      id, name, kind,
      context: this.context,
      log,
      defer(fn, opts = {}) {
        assertCanAddDefer(defers.length);
        defers.push({
          cleanup: fn,
          timeoutMs: opts.timeout !== undefined ? parseDuration(opts.timeout) : cleanupTimeoutMs,
        });
      },
      report(p) {
        scope.bus.emit({
          type: "task:progress",
          taskId: id,
          ...(p.pct !== undefined ? { pct: p.pct } : {}),
          ...(p.message !== undefined ? { message: p.message } : {}),
          ...(p.data !== undefined ? { data: p.data } : {}),
          at: Date.now(),
        }, scope.context);
      },
      consumeCost(amount) { consumeBudget(scope, CostBudget, amount); },
      consume(key, amount) { consumeBudget(scope, key, amount); },
      budgets() { return listVisibleBudgets(scope.context); },
    };
  }

  /** Returns the first non-background child failure observed by this scope. */
  childFailure(): unknown {
    return this.firstChildFailure;
  }

  /** Updates the visible attempt for a running task snapshot. */
  updateTaskAttempt(taskId: TaskId, attempt: number): void {
    const record = this.tasks.get(taskId);
    /* v8 ignore next -- retry wrappers update only task ids owned by this scope. */
    if (record !== undefined) record.attempt = attempt;
  }

  /** Emits a typed retry event for wrappers executing inside this scope. */
  emitTaskRetry(taskId: TaskId, attempt: number, error: unknown, nextDelayMs: number): void {
    this.bus.emit({ type: "task:retrying", taskId, attempt, error, nextDelayMs, at: Date.now() }, this.context);
  }

  /** Emits exactly one scope closing transition event. */
  private emitClosing(reason: "completed" | "errored" | "cancelled"): void {
    if (this.closingEmitted) return;
    this.closingEmitted = true;
    this.bus.emit(
      { type: "scope:closing", scopeId: this.id, reason, at: Date.now() },
      this.context
    );
  }
}

/** Creates a task-local logger backed by typed progress events. */
function makeTaskLogger(scope: ScopeImpl, taskId: TaskId): TaskLogger {
  const emit = (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => {
    scope.bus.emit({
      type: "task:progress",
      taskId,
      message,
      data: {
        logLevel: level,
        ...(fields !== undefined ? { fields } : {}),
      },
      at: Date.now(),
    }, scope.context);
  };

  return {
    debug(message, fields) { emit("debug", message, fields); },
    info(message, fields) { emit("info", message, fields); },
    warn(message, fields) { emit("warn", message, fields); },
    error(message, fields) { emit("error", message, fields); },
  };
}

/** Lists budget-shaped values explicitly installed in the visible context bag. */
function listVisibleBudgets(context: ContextBag): ReadonlyArray<{ key: string; state: BudgetState }> {
  if (!(context instanceof ContextBagImpl)) return [];
  return context.entriesSnapshot()
    .filter((entry): entry is readonly [string, BudgetState] => isBudgetState(entry[1]))
    .map(([key, state]) => ({ key, state }));
}

/** Runtime guard for budget-shaped context values. */
function isBudgetState(value: unknown): value is BudgetState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { limit?: unknown; spent?: unknown };
  return typeof candidate.limit === "number" && typeof candidate.spent === "number";
}

// --- Budget consumption --------------------------------------------------------

/**
 * Charges a cooperative budget installed in scope context.
 *
 * Missing budgets fail immediately at the consuming task boundary. Exhausted
 * budgets cancel the owning scope and throw `BudgetExceededError`. Successful
 * charges mutate the installed budget state; child scopes that need independent
 * limits must install their own budget state.
 */
function consumeBudget<T extends BudgetState>(
  scope: ScopeImpl,
  key: ContextKey<T>,
  amount: number
): void {
  assertBudgetCharge(amount);
  const state = getMutableBudgetState(scope.context, key);
  if (state === undefined) {
    throw new Error(`Budget "${key.name}" not set in scope`);
  }
  const nextSpent = normalizeBudgetAmount(state.spent + amount);
  if (nextSpent > state.limit) {
    const unit = state.unit ?? key.unit;
    const err = new BudgetExceededError({
      budgetKey: key.name,
      limit: state.limit,
      spent: nextSpent,
      attempted: amount,
      ...(unit !== undefined ? { unit } : {}),
    });
    // Cancel the budget owner, not just the leaf task that observed the overrun.
    const owner = findBudgetOwner(scope, key) ?? scope;
    owner.cancel(err.reason);
    throw err;
  }
  state.spent = nextSpent;
}

/** Maps cancellation reasons to scope-level close outcomes. */
function classifyClosingReason(reason: CancelReason): "completed" | "errored" | "cancelled" {
  switch (reason.kind) {
    case "parent_failed":
    case "sibling_failed":
    case "budget":
      return "errored";
    case "user":
    case "deadline":
    case "timeout":
    case "race_lost":
    case "scope_ended":
    case "manual":
      return "cancelled";
  }
}

/** Normalizes decimal budget arithmetic to avoid floating-point drift. */
function normalizeBudgetAmount(value: number): number {
  return Number(value.toFixed(12));
}

/** Finds the highest scope that owns the current visible budget key. */
function findBudgetOwner<T extends BudgetState>(
  scope: ScopeImpl,
  key: ContextKey<T>
): ScopeImpl | null {
  const visibleState = getBudgetIdentity(scope.context, key) ?? getMutableBudgetState(scope.context, key);
  let cur: ScopeImpl | null = scope;
  while (cur) {
    const curIdentity = getBudgetIdentity(cur.context, key) ?? getMutableBudgetState(cur.context, key);
    const parentIdentity = cur.parent === null
      ? undefined
      : getBudgetIdentity(cur.parent.context, key) ?? getMutableBudgetState(cur.parent.context, key);
    const ownsVisibleState = cur.context.has(key) && curIdentity === visibleState;
    const parentHasSameState = parentIdentity === visibleState;
    if (ownsVisibleState && !parentHasSameState) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function getMutableBudgetState<T extends BudgetState>(
  context: ContextBag,
  key: ContextKey<T>
): T | undefined {
  if (context instanceof ContextBagImpl) return context.getMutableBudget(key);
  return context.get(key);
}

function getBudgetIdentity<T extends BudgetState>(
  context: ContextBag,
  key: ContextKey<T>
): unknown {
  return context instanceof ContextBagImpl ? context.budgetIdentity(key) : undefined;
}

function assertBudgetCharge(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError("Budget charge amount must be a finite non-negative number");
  }
}

function assertCanAddDefer(currentCount: number): void {
  if (currentCount >= MAX_DEFERS_PER_OWNER) {
    throw new RangeError(`A task or scope cannot register more than ${MAX_DEFERS_PER_OWNER} cleanup callbacks`);
  }
}

async function runCleanup(record: CleanupRecord): Promise<"completed" | "timed_out"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new TimeoutError(record.timeoutMs));
      resolve("timed_out");
    }, record.timeoutMs);
  });
  const cleanup = Promise.resolve()
    .then(() => record.cleanup({ signal: controller.signal, timeoutMs: record.timeoutMs }))
    .then(() => "completed" as const);
  void cleanup.catch(() => undefined);

  try {
    return await Promise.race([cleanup, timeout]);
  } finally {
    /* v8 ignore next -- cleanup timeout assigns the timer synchronously. */
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertBoundedString(label: string, value: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength) {
    throw new RangeError(`${label} must be 1-${maxLength} characters`);
  }
}

function assertNoTaskPolicyShortcuts(opts: TaskOpts): void {
  const raw = opts as Record<string, unknown>;
  if ("retry" in raw || "timeout" in raw || "deadline" in raw) {
    throw new Error("Task retry, timeout, and deadline policies must use run.retry/run.timeout/run.deadline wrappers");
  }
}

// --- run.group - the canonical scope opener -----------------------------------

/** Function object used by `group()` bodies to spawn owned tasks. */
export interface TaskSpawner {
  <T>(fn: TaskFn<T>, opts?: TaskOpts): TaskHandle<T>;

  /** Spawns a named background task that is still owned by the current scope. */
  background<T>(fn: TaskFn<T>): TaskHandle<T>;
}

/**
 * Opens a scope, runs a body, waits for owned work, and returns the body result.
 *
 * `group()` binds the scope through AsyncLocalStorage, cancels owned children
 * when the body fails, waits for all non-detached work, and only then resolves
 * or rethrows.
 */
export async function group<R>(
  body: (task: TaskSpawner) => Promise<R>,
  opts: ScopeOpts = {}
): Promise<R> {
  const parent = getCurrentScope();
  const scope = new ScopeImpl(parent, opts);

  const spawner: TaskSpawner = Object.assign(
    <T>(fn: TaskFn<T>, taskOpts?: TaskOpts) => scope.spawn(fn, taskOpts),
    { background: <T>(fn: TaskFn<T>) => scope.spawn(fn, { name: "background" }, true) }
  );

  let result: R | undefined;
  let bodyError: unknown = undefined;

  try {
    result = await currentScope.run(scope, () => body(spawner));
  } catch (err) {
    bodyError = err;
    if (!(err instanceof CancellationError) || err instanceof TimeoutError) {
      scope.cancel({ kind: "parent_failed", error: err });
    }
  }

  await scope.close();

  if (bodyError !== undefined) throw bodyError;
  const childFailure = scope.childFailure();
  if (childFailure !== undefined) throw childFailure;
  return result as R;
}
