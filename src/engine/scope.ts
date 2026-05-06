/**
 * Scope - the structured concurrency primitive.
 *
 * @author Admilson B. F. Cossa
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
} from "../types/index.js";
import { CancellationError, BudgetExceededError, CostBudget } from "../types/index.js";
import { ContextBagImpl } from "./context.js";
import { EventBus } from "./event-bus.js";
import { parseDuration } from "./duration.js";

// --- ID generation ------------------------------------------------------
let _nextId = 0;
const makeScopeId = (): ScopeId => `scope-${++_nextId}` as ScopeId;
const makeTaskId = (): TaskId => `task-${++_nextId}` as TaskId;

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

// --- AbortSignal.any polyfill (Node <20 / older runtimes) -------------

/** Links multiple abort signals into one signal without changing their owners. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: Function }).any === "function") {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
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
  private readonly defers: Array<() => void | Promise<void>> = [];
  private readonly cancelHandlers = new Set<(r: CancelReason) => void>();
  private state: "running" | "cancelling" | "closed" = "running";
  private readonly startedAt = Date.now();
  private deadlineAt?: number;
  private deadlineTimer?: ReturnType<typeof setTimeout>;

  /** Opens a scope under an optional parent and emits `scope:opened`. */
  constructor(parent: ScopeImpl | null, opts: ScopeOpts = {}) {
    this.parent = parent;
    this.context = opts.context ?? parent?.context ?? new ContextBagImpl();
    this.name = opts.name;
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
  spawn<T>(task: TaskFn<T>, opts: TaskOpts = {}): TaskHandle<T> {
    if (this.state !== "running") {
      throw new Error(`Cannot spawn on a ${this.state} scope`);
    }
    const id = makeTaskId();
    const name = opts.name ?? "anonymous";
    const kind = opts.kind ?? "io";
    const startedAt = Date.now();

    const taskAbort = new AbortController();
    const taskSignal = anySignal([this.signal, taskAbort.signal]);
    const defers: Array<() => void | Promise<void>> = [];

    const ctx = this.makeTaskContext(id, name, kind, taskSignal, defers);

    const record: TaskRecord<T> = {
      id, name, kind,
      status: "pending",
      attempt: 1,
      startedAt,
      promise: undefined as unknown as Promise<T>,
      cancel: (reason) => taskAbort.abort(new CancellationError(reason)),
      ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    };
    this.tasks.set(id, record as TaskRecord);

    this.bus.emit(
      { type: "task:started", taskId: id, scopeId: this.id, name, kind, at: startedAt },
      this.context
    );

    const promise = (async () => {
      record.status = "running";
      try {
        const value = await currentScope.run(this, () => task(ctx));
        record.status = "succeeded";
        record.endedAt = Date.now();
        this.bus.emit(
          { type: "task:succeeded", taskId: id, durationMs: record.endedAt - startedAt, at: record.endedAt },
          this.context
        );
        return value;
      } catch (err) {
        record.endedAt = Date.now();
        if (err instanceof CancellationError) {
          record.status = "cancelled";
          this.bus.emit(
            { type: "task:cancelled", taskId: id, reason: err.reason, durationMs: record.endedAt - startedAt, at: record.endedAt },
            this.context
          );
        } else {
          record.status = "failed";
          this.bus.emit(
            { type: "task:failed", taskId: id, error: err, durationMs: record.endedAt - startedAt, at: record.endedAt },
            this.context
          );
        }
        throw err;
      } finally {
        // Run defers LIFO; errors logged, never thrown (I5)
        while (defers.length > 0) {
          const fn = defers.pop()!;
          try { await fn(); } catch (cleanupErr) {
            this.bus.emit(
              { type: "task:failed", taskId: id, error: cleanupErr, durationMs: 0, at: Date.now() },
              this.context
            );
          }
        }
      }
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
        const r: CancelReason = typeof reason === "string" ? { kind: "manual", tag: reason } : reason;
        record.cancel(r);
      },
    });

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
    const r: CancelReason = typeof reason === "string" ? { kind: "manual", tag: reason } : reason;
    this.state = "cancelling";
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    try { this.ownAbort.abort(new CancellationError(r)); } catch { /* already aborted */ }
    for (const handler of this.cancelHandlers) {
      try { handler(r); } catch { /* cancel handler errors must not propagate */ }
    }
    this.bus.emit(
      { type: "scope:closing", scopeId: this.id, reason: "cancelled", at: Date.now() },
      this.context
    );
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
  defer(cleanup: () => void | Promise<void>): void {
    this.defers.push(cleanup);
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
      if (all.length === 0) break;
      await Promise.all(all);
      // Drain: remove settled records
      for (const [id, t] of this.tasks) {
        if (t.status !== "pending" && t.status !== "running") this.tasks.delete(id);
      }
    }

    // Run defers LIFO, errors logged not thrown (I5)
    while (this.defers.length > 0) {
      const fn = this.defers.pop()!;
      try { await fn(); } catch (err) {
        this.bus.emit(
          { type: "task:failed", taskId: makeTaskId(), error: err, durationMs: 0, at: Date.now() },
          this.context
        );
      }
    }

    if (this.parent) this.parent.childScopes.delete(this);
    this.state = "closed";
    this.bus.emit(
      { type: "scope:closed", scopeId: this.id, durationMs: Date.now() - this.startedAt, at: Date.now() },
      this.context
    );
  }

  /** Waits until this scope reaches `closed` without cancelling it. */
  private async awaitClose(): Promise<void> {
    while (this.state !== "closed") {
      await new Promise<void>(r => setTimeout(r, 0));
    }
  }

  // -- Status snapshot (section 3.9) ------------------------------------------

  /** Returns a point-in-time snapshot of this scope and currently retained children. */
  status(): ScopeSnapshot {
    let pending = 0, completed = 0, failed = 0, cancelled = 0;
    const taskSnaps: TaskSnapshot[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === "pending" || t.status === "running") pending++;
      else if (t.status === "succeeded") completed++;
      else if (t.status === "failed") failed++;
      else if (t.status === "cancelled") cancelled++;

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
      pendingCount: pending,
      completedCount: completed,
      failedCount: failed,
      cancelledCount: cancelled,
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
    defers: Array<() => void | Promise<void>>
  ): import("../types/index.js").TaskContext {
    const scope = this;
    return {
      signal,
      scope,
      attempt: 1,
      id, name, kind,
      context: this.context,
      defer(fn) { defers.push(fn); },
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
    };
  }
}

// --- Budget consumption (section 2.3 rules B1-B6) ------------------------------

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
  const state = scope.context.get(key);
  if (state === undefined) {
    throw new Error(`Budget "${key.name}" not set in scope`);
  }
  if (state.spent + amount > state.limit) {
    const unit = state.unit ?? key.unit;
    const err = new BudgetExceededError({
      budgetKey: key.name,
      limit: state.limit,
      spent: state.spent,
      attempted: amount,
      ...(unit !== undefined ? { unit } : {}),
    });
    // Cancel the budget owner, not just the leaf task that observed the overrun.
    const owner = findBudgetOwner(scope, key) ?? scope;
    owner.cancel(err.reason);
    throw err;
  }
  state.spent += amount;
}

/** Finds the highest scope that owns the current visible budget key. */
function findBudgetOwner<T extends BudgetState>(
  scope: ScopeImpl,
  key: ContextKey<T>
): ScopeImpl | null {
  let cur: ScopeImpl | null = scope;
  while (cur) {
    if (cur.context.has(key) && (!cur.parent || !cur.parent.context.has(key))) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

// --- run.group - the canonical scope opener (section 6.2) ---------------------

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
    { background: <T>(fn: TaskFn<T>) => scope.spawn(fn, { name: "background" }) }
  );

  let result: R | undefined;
  let bodyError: unknown = undefined;

  try {
    result = await currentScope.run(scope, () => body(spawner));
  } catch (err) {
    bodyError = err;
    if (!(err instanceof CancellationError)) {
      scope.cancel({ kind: "parent_failed", error: err });
    }
  }

  await scope.close();

  if (bodyError !== undefined) throw bodyError;
  return result as R;
}
