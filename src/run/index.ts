/**
 * Run namespace - task composition and resilience helpers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The functions in this module are thin policy layers over the scope engine.
 * They must spawn work through `group()`/`ScopeImpl` so cancellation, cleanup,
 * context, and events keep the same ownership semantics as direct scope usage.
 */

import {
  CancellationError,
  ContextBag,
  ContextKey,
  Duration,
  HedgeOpts,
  RetryOpts,
  RunNamespace,
  Scope,
  ScopeOpts,
  Settled,
  TaskFn,
  TaskHandle,
  TaskContext,
  TaskResults,
  TimeoutError,
  WorkAggregateError,
  BreakerOpts,
  DetachedOpts,
  BudgetState,
  CleanupOpts,
  CleanupContext,
} from "../types/index.js";
import { ContextBagImpl } from "../engine/context.js";
import { ScopeImpl, getCurrentScope, group } from "../engine/scope.js";
import { parseDuration } from "../engine/duration.js";
import { computeBackoffDelay, computeRetryDelay, normalizeRetry, sleep } from "../engine/retry.js";

/** Runs all tasks concurrently and preserves input-order results. */
async function all<T extends readonly TaskFn<unknown>[]>(tasks: T): Promise<TaskResults<T>> {
  return group(async (task) => {
    const handles = tasks.map((fn) => task(fn));
    return Promise.all(handles) as Promise<TaskResults<T>>;
  });
}

/** Runs all tasks and collects every settlement without cancelling on failures. */
async function allSettled<T>(tasks: TaskFn<T>[]): Promise<Settled<T>[]> {
  return group(async (task) => {
    const handles = tasks.map((fn) => task(async (ctx) => {
      try {
        return { status: "fulfilled", value: await fn(ctx) } satisfies Settled<T>;
      } catch (err) {
        if (err instanceof CancellationError) {
          return { status: "cancelled", reason: err.reason } satisfies Settled<T>;
        }
        return { status: "rejected", reason: err } satisfies Settled<T>;
      }
    }));
    return Promise.all(handles);
  });
}

/** Returns the first task settlement and cancels the remaining tasks. */
async function race<T>(tasks: TaskFn<T>[]): Promise<T> {
  if (tasks.length === 0) throw new WorkAggregateError([], "run.race requires at least one task");

  return group(async (task) => {
    const handles = tasks.map((fn) => task(fn));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      for (const handle of handles) {
        handle.then(
          (value) => {
            if (settled) return;
            settled = true;
            cancelLosers(handles, handle);
            resolve(value);
          },
          (err: unknown) => {
            if (settled) return;
            settled = true;
            cancelLosers(handles, handle);
            reject(err);
          }
        );
      }
    });
  });
}

/** Returns the first successful task, rejecting only after every task fails. */
async function any<T>(tasks: TaskFn<T>[]): Promise<T> {
  if (tasks.length === 0) throw new WorkAggregateError([], "run.any requires at least one task");

  return group(async (task) => {
    const scope = getCurrentScope();
    const errors: unknown[] = [];
    const handles = tasks.map((fn) => task(async (ctx) => {
      try {
        return { status: "fulfilled", value: await fn(ctx) } satisfies Settled<T>;
      } catch (err) {
        errors.push(err);
        if (err instanceof CancellationError) {
          return { status: "cancelled", reason: err.reason } satisfies Settled<T>;
        }
        return { status: "rejected", reason: err } satisfies Settled<T>;
      }
    }, { name: "any-candidate" }));

    return new Promise<T>((resolve, reject) => {
      let pending = handles.length;
      let settled = false;
      for (const handle of handles) {
        handle.then((settlement) => {
          if (settled) return;
          pending--;
          if (settlement.status !== "fulfilled") {
            if (pending === 0) {
              settled = true;
              reject(scope?.signal.aborted === true ? scope.signal.reason : new WorkAggregateError(errors));
            }
            return;
          }
          settled = true;
          cancelLosers(handles, handle);
          resolve(settlement.value);
        });
      }
    });
  });
}

/** Runs tasks sequentially and stops on the first failure. */
async function series<T>(tasks: TaskFn<T>[]): Promise<T[]> {
  return group(async (task) => {
    const results: T[] = [];
    for (const fn of tasks) {
      results.push(await task(fn));
    }
    return results;
  });
}

/** Runs tasks with bounded concurrency and preserves input-order results. */
async function pool<T>(concurrency: number, tasks: TaskFn<T>[]): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("run.pool concurrency must be a positive integer");
  }

  return group(async (task) => {
    const results = new Array<T>(tasks.length);
    let next = 0;

    async function worker(): Promise<void> {
      while (next < tasks.length) {
        const index = next++;
        const fn = tasks[index]!;
        results[index] = await task(fn);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
  });
}

/** Wraps a task with a timeout that rejects with `TimeoutError`. */
function timeout<T>(task: TaskFn<T>, duration: Duration): TaskFn<T> {
  const timeoutMs = parseDuration(duration);
  return async (ctx) => {
    const ctrl = new AbortController();
    const signal = AbortSignal.any([ctx.signal, ctrl.signal]);

    let timer!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new TimeoutError(timeoutMs);
        ctrl.abort(err);
        reject(err);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        task({ ...ctx, signal }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Runs a task in a bounded cancellation shield. */
function uncancellable<T>(task: TaskFn<T>, opts?: { timeout?: Duration }): TaskFn<T> {
  const timeoutMs = parseDuration(opts?.timeout ?? 0);
  if (timeoutMs <= 0) throw new RangeError("timeout");
  return timeout(async (ctx) => {
    const ctrl = new AbortController();
    const signal = ctx.signal;
    let parentReason: unknown;
    const onAbort = () => signal.reason instanceof TimeoutError
      ? ctrl.abort(signal.reason)
      : parentReason = signal.reason;
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      const value = await task({ ...ctx, signal: ctrl.signal });
      if (parentReason) throw parentReason;
      return value;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }, timeoutMs);
}

/** Wraps a task with a deadline timestamp. */
function deadline<T>(task: TaskFn<T>, at: number | Date): TaskFn<T> {
  const deadlineAt = typeof at === "number" ? at : at.getTime();
  return timeout(task, Math.max(0, deadlineAt - Date.now()));
}

/** Retries a task according to a cancel-aware retry policy. */
function retry<T>(task: TaskFn<T>, opts: number | RetryOpts): TaskFn<T> {
  const policy = normalizeRetry(opts);
  return async (ctx) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= policy.times; attempt++) {
      if (ctx.scope instanceof ScopeImpl) ctx.scope.updateTaskAttempt(ctx.id, attempt);
      try {
        return await task({ ...ctx, attempt });
      } catch (err) {
        lastErr = err;
        if (err instanceof CancellationError) throw err;
        if (attempt >= policy.times || !policy.retryIf(err, attempt)) throw err;

        const delayMs = computeRetryDelay(attempt, policy);
        if (ctx.scope instanceof ScopeImpl) ctx.scope.emitTaskRetry(ctx.id, attempt + 1, err, delayMs);
        else ctx.report({ data: { retrying: true, attempt: attempt + 1, delayMs } });
        await sleep(delayMs, ctx.signal);
      }
    }
    /* v8 ignore next -- normalizeRetry guarantees at least one attempt. */
    throw lastErr;
  };
}

/** Starts hedged attempts and returns the first success. */
function hedge<T>(task: TaskFn<T>, opts: HedgeOpts): TaskFn<T> {
  return async (ctx) => {
    const max = Math.max(1, opts.max);
    const afterMs = parseDuration(opts.after);
    const controllers: AbortController[] = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const errors: unknown[] = [];

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let completed = 0;

      const clearPendingStarts = () => {
        while (timers.length > 0) {
          const timer = timers.pop();
          /* v8 ignore else -- loop condition guarantees a timer was present. */
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearPendingStarts();
        finish();
      };

      if (ctx.signal.aborted) {
        reject(ctx.signal.reason);
        return;
      }

      ctx.signal.addEventListener(
        "abort",
        () => {
          settle(() => {
            for (const candidate of controllers) candidate.abort(ctx.signal.reason);
            reject(ctx.signal.reason);
          });
        },
        { once: true }
      );

      const start = (attempt: number) => {
        /* v8 ignore next -- pending timers are cleared on settlement; this is a race guard. */
        if (settled) return;
        const ctrl = new AbortController();
        controllers.push(ctrl);
        const signal = AbortSignal.any([ctx.signal, ctrl.signal]);
        task({ ...ctx, signal, attempt }).then(
          (value) => {
            settle(() => {
              for (const candidate of controllers) candidate.abort(new CancellationError({ kind: "race_lost", winnerId: ctx.id }));
              resolve(value);
            });
          },
          (err: unknown) => {
            if (settled) return;
            errors.push(err);
            completed++;
            if (!settled && completed === max) {
              settle(() => reject(new WorkAggregateError(errors, "All hedges failed")));
            }
          }
        );
      };

      for (let attempt = 1; attempt <= max; attempt++) {
        const delayMs = (attempt - 1) * afterMs;
        if (delayMs === 0) start(attempt);
        else timers.push(setTimeout(() => start(attempt), delayMs));
      }
    });
  };
}

/** Falls back to a secondary task when the primary fails for a non-cancellation reason. */
function fallback<T>(primary: TaskFn<T>, secondary: TaskFn<T>): TaskFn<T> {
  return async (ctx) => {
    try {
      return await primary(ctx);
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      return await secondary(ctx);
    }
  };
}

/** Acquires a resource, uses it, and releases it through bounded task cleanup. */
function bracket<R, T>(
  acquire: (ctx: TaskContext) => R | Promise<R>,
  use: (resource: R, ctx: TaskContext) => T | Promise<T>,
  release: (resource: R, ctx: CleanupContext) => void | Promise<void>,
  opts?: CleanupOpts
): TaskFn<T> {
  return async (ctx) => {
    const resource = await acquire(ctx);
    ctx.defer((cleanupCtx) => release(resource, cleanupCtx), opts);
    return use(resource, ctx);
  };
}

/** Wraps a task with a small in-process circuit breaker. */
function circuitBreaker<T>(task: TaskFn<T>, opts: BreakerOpts): TaskFn<T> {
  let state = 0;
  let failures = 0;
  let openedUntil = 0;
  let epoch = 0;
  let admitted = 0;
  const maxHalfOpenCalls = opts.halfOpenMaxCalls ?? 1;
  const resetAfterMs = parseDuration(opts.resetAfter);

  const open = () => {
    state = 1;
    openedUntil = Date.now() + resetAfterMs;
  };
  const close = () => {
    state = 0;
    failures = 0;
  };
  const halfOpen = () => {
    state = 2;
    epoch++;
    admitted = 0;
  };

  return async (ctx) => {
    if (state === 1) {
      if (Date.now() < openedUntil) throw new Error("Circuit open");
      halfOpen();
    }

    if (state === 2 && admitted >= maxHalfOpenCalls) {
      throw new Error("Circuit half-open");
    }

    const halfOpenEpoch = state === 2 ? epoch : 0;
    if (state === 2) admitted++;

    try {
      const value = await task(ctx);
      if (halfOpenEpoch > 0) {
        if (state === 2 && epoch === halfOpenEpoch) close();
      } else if (state === 0) {
        close();
      }
      return value;
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      if (halfOpenEpoch > 0) {
        if (halfOpenEpoch === epoch) open();
        throw err;
      }
      if (state === 0) {
        failures++;
        if (failures >= opts.failureThreshold) open();
      }
      throw err;
    }
  };
}

/** Opens a scope and passes the concrete scope to the body. */
async function scope<R>(body: (scope: Scope) => Promise<R>, opts: ScopeOpts = {}): Promise<R> {
  return group(async (task) => {
    return task(async (ctx) => body(ctx.scope), { name: opts.name ?? "scope-body" });
  }, opts);
}

/** Spawns background work in the current scope. */
function background<T>(task: TaskFn<T>): TaskHandle<T> {
  const current = getCurrentScope();
  if (!current) throw new Error("run.background requires an active WorkJS scope");
  return current.spawn(task, { name: "background" }, true);
}

const DEFAULT_DETACHED_MAX_LIFETIME_MS = 300_000;

/** Spawns explicitly detached work in a root scope. */
function detached<T>(task: TaskFn<T>, opts: DetachedOpts = {}): TaskHandle<T> {
  const root = new ScopeImpl(null, {
    name: opts.name ?? "detached",
    ...(opts.cleanupTimeout !== undefined ? { cleanupTimeout: opts.cleanupTimeout } : {}),
  });
  const boundedTask = opts.maxLifetime === false
    ? task
    : timeout(task, opts.maxLifetime ?? DEFAULT_DETACHED_MAX_LIFETIME_MS);
  const handle = root.spawn(boundedTask, { name: opts.name ?? "detached" });
  void handle.finally(() => root.close()).catch(() => undefined);
  return handle;
}

/** Spawns a simple supervised task that can restart after failures. */
function supervise<T>(task: TaskFn<T>, opts: {
  restartOn?: "error" | "always" | ((err: unknown) => boolean);
  maxRestarts?: number;
  resetWindow?: Duration;
  backoff?: RetryOpts["backoff"];
} = {}): TaskHandle<T> {
  const maxRestarts = opts.maxRestarts ?? 3;
  const resetWindowMs = opts.resetWindow !== undefined ? parseDuration(opts.resetWindow) : 60_000;
  const startedAt = Date.now();

  const supervised: TaskFn<T> = async (ctx) => {
    let restarts = 0;
    while (true) {
      try {
        return await task(ctx);
      } catch (err) {
        if (err instanceof CancellationError) throw err;
        const shouldRestart = opts.restartOn === "always"
          || opts.restartOn === "error"
          || (typeof opts.restartOn === "function" && opts.restartOn(err))
          || opts.restartOn === undefined;
        const windowExpired = Date.now() - startedAt > resetWindowMs;
        if (!shouldRestart || restarts >= maxRestarts || windowExpired) throw err;
        restarts++;
        await sleep(computeBackoffDelay(restarts, opts.backoff), ctx.signal);
      }
    }
  };

  const current = getCurrentScope();
  return current ? current.spawn(supervised, { name: "supervised" }) : detached(supervised);
}

/** Context helper namespace. */
const context = {
  current(): ContextBag {
    return getCurrentScope()?.context ?? new ContextBagImpl();
  },

  async with<T, R>(key: ContextKey<T>, value: T, body: () => Promise<R>): Promise<R> {
    const next = context.current().with(key, value);
    return group(async () => body(), { context: next });
  },

  get<T>(key: ContextKey<T>): T | undefined {
    return context.current().get(key);
  },

  budget<T extends BudgetState>(key: ContextKey<T>): T | undefined {
    const value = context.current().get(key);
    if (value === undefined) return undefined;
    return {
      spent: value.spent,
      limit: value.limit,
      ...(value.unit !== undefined ? { unit: value.unit } : {}),
    } as T;
  },
};

/** The public run namespace. */
export const run: RunNamespace = {
  all,
  allSettled,
  any,
  race,
  series,
  pool,
  timeout,
  uncancellable,
  deadline,
  retry,
  hedge,
  fallback,
  bracket,
  circuitBreaker,
  group,
  scope,
  background,
  detached,
  supervise,
  context,
};

function cancelLosers<T>(handles: TaskHandle<T>[], winner: TaskHandle<T>): void {
  for (const handle of handles) {
    if (handle !== winner) handle.cancel({ kind: "race_lost", winnerId: winner.id });
  }
}
