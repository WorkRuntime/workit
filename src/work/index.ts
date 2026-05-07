/**
 * Work builder - fluent bounded batch execution.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The builder keeps conservative defaults: sequential execution, no retry, no
 * timeout, and fail-fast error handling unless the caller explicitly opts into
 * a different policy.
 */

import type {
  CancelledItem,
  Duration,
  ItemError,
  RetryOpts,
  Settled,
  Scope,
  TaskContext,
  TaskFn,
  WorkBuilder,
  WorkCancelMode,
  WorkErrorMode,
  WorkFactory,
  WorkItemDoneEvent,
  WorkOutputFor,
  WorkProgressEvent,
} from "../types/index.js";
import { CancellationError } from "../types/index.js";
import { run } from "../run/index.js";

type Transform =
  | { kind: "map"; fn: (item: unknown, ctx: TaskContext) => unknown | Promise<unknown> }
  | { kind: "filter"; fn: (item: unknown, ctx: TaskContext) => boolean | Promise<boolean> }
  | { kind: "tap"; fn: (item: unknown, ctx: TaskContext) => void | Promise<void> };

interface WorkConfig {
  concurrency?: number;
  rateLimitPerSecond?: number;
  retry?: number | RetryOpts;
  timeout?: Duration;
  deadlineAt?: number;
  errorMode?: "fail" | "continue" | "collect";
  cancelMode?: "throw" | "partial";
  transforms: Transform[];
  progressHandlers?: Array<(event: WorkProgressEvent<unknown>) => void>;
  itemDoneHandlers?: Array<(event: WorkItemDoneEvent<unknown, unknown>) => void>;
}

const SKIP = Symbol("work.skip");

type StreamSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };
type ActiveStreamSettlement<T> = StreamSettlement<T> & {
  promise: Promise<ActiveStreamSettlement<T>>;
};

/** Creates a fluent builder over an iterable or async iterable source. */
export const work: WorkFactory = <I>(items: Iterable<I> | AsyncIterable<I>) =>
  new WorkBuilderImpl<I, I>(items, { transforms: [] });

class WorkBuilderImpl<
  I,
  O,
  M extends WorkErrorMode = "fail",
  C extends WorkCancelMode = "throw",
> implements WorkBuilder<I, O, M, C> {
  constructor(
    private readonly source: Iterable<I> | AsyncIterable<I>,
    private readonly cfg: WorkConfig
  ) {}

  inParallel(n: number): WorkBuilder<I, O, M, C> {
    assertConcurrency(n);
    return new WorkBuilderImpl<I, O, M, C>(this.source, { ...this.cfg, concurrency: n });
  }

  inSeries(): WorkBuilder<I, O, M, C> {
    return this.inParallel(1);
  }

  withConcurrencyLimit(n: number): WorkBuilder<I, O, M, C> {
    return this.inParallel(n);
  }

  withRateLimit(perSecond: number): WorkBuilder<I, O, M, C> {
    assertRateLimit(perSecond);
    return new WorkBuilderImpl<I, O, M, C>(this.source, { ...this.cfg, rateLimitPerSecond: perSecond });
  }

  withRetry(opts: number | RetryOpts): WorkBuilder<I, O, M, C> {
    return new WorkBuilderImpl<I, O, M, C>(this.source, { ...this.cfg, retry: opts });
  }

  withTimeout(duration: Duration): WorkBuilder<I, O, M, C> {
    return new WorkBuilderImpl<I, O, M, C>(this.source, { ...this.cfg, timeout: duration });
  }

  withDeadline(at: number | Date): WorkBuilder<I, O, M, C> {
    const deadlineAt = typeof at === "number" ? at : at.getTime();
    return new WorkBuilderImpl<I, O, M, C>(this.source, { ...this.cfg, deadlineAt });
  }

  onError<N extends WorkErrorMode>(strategy: N): WorkBuilder<I, O, N, C> {
    return new WorkBuilderImpl<I, O, N, C>(this.source, { ...this.cfg, errorMode: strategy });
  }

  onCancel<N extends WorkCancelMode>(strategy: N): WorkBuilder<I, O, M, N> {
    return new WorkBuilderImpl<I, O, M, N>(this.source, { ...this.cfg, cancelMode: strategy });
  }

  onProgress(handler: (event: WorkProgressEvent<I>) => void): WorkBuilder<I, O, M, C> {
    return new WorkBuilderImpl<I, O, M, C>(this.source, {
      ...this.cfg,
      progressHandlers: [
        ...(this.cfg.progressHandlers ?? []),
        handler as (event: WorkProgressEvent<unknown>) => void,
      ],
    });
  }

  onItemDone<R>(handler: (event: WorkItemDoneEvent<I, R>) => void): WorkBuilder<I, O, M, C> {
    return new WorkBuilderImpl<I, O, M, C>(this.source, {
      ...this.cfg,
      itemDoneHandlers: [
        ...(this.cfg.itemDoneHandlers ?? []),
        handler as (event: WorkItemDoneEvent<unknown, unknown>) => void,
      ],
    });
  }

  map<R>(fn: (item: O, ctx: TaskContext) => R | Promise<R>): WorkBuilder<I, R, M, C> {
    return new WorkBuilderImpl<I, R, M, C>(this.source, {
      ...this.cfg,
      transforms: [...this.cfg.transforms, {
        kind: "map",
        fn: fn as (item: unknown, ctx: TaskContext) => unknown | Promise<unknown>,
      }],
    });
  }

  filter(fn: (item: O, ctx: TaskContext) => boolean | Promise<boolean>): WorkBuilder<I, O, M, C> {
    return new WorkBuilderImpl<I, O, M, C>(this.source, {
      ...this.cfg,
      transforms: [...this.cfg.transforms, {
        kind: "filter",
        fn: fn as (item: unknown, ctx: TaskContext) => boolean | Promise<boolean>,
      }],
    });
  }

  tap(fn: (item: O, ctx: TaskContext) => void | Promise<void>): WorkBuilder<I, O, M, C> {
    return new WorkBuilderImpl<I, O, M, C>(this.source, {
      ...this.cfg,
      transforms: [...this.cfg.transforms, {
        kind: "tap",
        fn: fn as (item: unknown, ctx: TaskContext) => void | Promise<void>,
      }],
    });
  }

  async do<R>(fn: (item: O, ctx: TaskContext) => R | Promise<R>): Promise<WorkOutputFor<R, M, C>> {
    const items = await toArray(this.source);
    const mode = this.cfg.errorMode ?? "fail";
    const cancelMode = this.cfg.cancelMode ?? "throw";
    const execution = createExecution(this.cfg);
    const tasks = items.map((item, index) => this.makeTask(item, index, fn, execution));

    if (mode === "fail" && cancelMode === "throw") {
      const raw = await run.pool(this.cfg.concurrency ?? 1, tasks);
      return { mode: "fail", results: raw.filter(isNotSkipped) } as WorkOutputFor<R, M, C>;
    }

    const settledTasks = tasks.map((task, index) => async (ctx: TaskContext) => {
      try {
        const value = await task(ctx);
        if (value === SKIP) return { status: "cancelled", reason: { kind: "manual", tag: "filtered" } } satisfies Settled<R>;
        return { status: "fulfilled", value } satisfies Settled<R>;
      } catch (err) {
        if (err instanceof CancellationError) {
          return { status: "cancelled", reason: err.reason } satisfies Settled<R>;
        }
        if (mode === "fail") throw err;
        return {
          status: "rejected",
          reason: toItemError(index, items[index], err),
        } satisfies Settled<R>;
      }
    });

    const settled = await run.pool(this.cfg.concurrency ?? 1, settledTasks);
    if (mode === "collect") return { mode: "collect", results: settled } as WorkOutputFor<R, M, C>;

    const results: R[] = [];
    const errors: ItemError[] = [];
    const cancelled: CancelledItem[] = [];
    for (let index = 0; index < settled.length; index++) {
      const item = settled[index]!;
      if (item.status === "fulfilled") results.push(item.value);
      else if (item.status === "rejected") errors.push(item.reason as ItemError);
      else cancelled.push({ index, item: items[index], reason: item.reason });
    }
    if (mode === "fail") {
      if (cancelled.length === 0) return { mode: "fail", results } as WorkOutputFor<R, M, C>;
      return { mode: "partial", results, errors, cancelled, reason: cancelled[0]!.reason } as WorkOutputFor<R, M, C>;
    }
    return { mode: "continue", results, errors } as WorkOutputFor<R, M, C>;
  }

  async collect(): Promise<O[]> {
    const failFast = new WorkBuilderImpl<I, O>(this.source, { ...this.cfg, errorMode: "fail" });
    const output = await failFast.do((item) => item);
    /* v8 ignore next -- collect() forces fail mode above. */
    if (output.mode !== "fail") throw new Error("Unexpected collect mode");
    return output.results;
  }

  async *stream(): AsyncIterable<O> {
    const iterator = toAsyncIterator(this.source);
    const concurrency = this.cfg.concurrency ?? 1;
    const execution = createExecution(this.cfg);
    let nextKey = 0;
    let sourceDone = false;
    let scopeClosed = false;
    let resolveScope!: () => void;
    let rejectScope!: (reason: unknown) => void;
    let resolveScopeReady!: (scope: Scope) => void;
    const active = new Set<Promise<ActiveStreamSettlement<O | typeof SKIP>>>();
    const scopeReady = new Promise<Scope>((resolve) => {
      resolveScopeReady = resolve;
    });
    const scopeHold = new Promise<void>((resolve, reject) => {
      resolveScope = resolve;
      rejectScope = reject;
    });
    const scopeRun = run.scope(async (scope) => {
      resolveScopeReady(scope);
      await scopeHold;
    }, { name: "work-stream" });
    const scope = await scopeReady;

    const closeScope = async (reason?: unknown) => {
      scopeClosed = true;
      if (reason === undefined) resolveScope();
      else rejectScope(reason);
      await scopeRun.catch(() => undefined);
    };

    const launchNext = async () => {
      if (sourceDone || scope.signal.aborted) return;
      const next = await iterator.next();
      if (next.done === true) {
        sourceDone = true;
        return;
      }
      const index = nextKey++;
      const handle = scope.spawn(
        this.makeTask<O>(next.value, index, (item) => item, execution),
        { name: `work-stream-item-${index}` }
      );
      let ready!: Promise<ActiveStreamSettlement<O | typeof SKIP>>;
      ready = handle.then(
        (value) => ({ status: "fulfilled", value, promise: ready }),
        (reason: unknown) => ({ status: "rejected", reason, promise: ready })
      );
      active.add(ready);
    };

    try {
      while (active.size < concurrency && !sourceDone) await launchNext();
      while (active.size > 0) {
        const settlement = await Promise.race(active);
        active.delete(settlement.promise);
        if (settlement.status === "rejected") throw settlement.reason;
        if (settlement.value !== SKIP) yield settlement.value;
        await launchNext();
      }
      await closeScope();
    } catch (err) {
      scope.cancel({ kind: "manual", tag: "stream_failed" });
      await closeScope(err);
      throw err;
    } finally {
      if (!scopeClosed) {
        scope.cancel({ kind: "manual", tag: "stream_consumer_closed" });
        await closeScope();
      }
    }
  }

  private makeTask<R>(
    item: I,
    index: number,
    terminal: (item: O, ctx: TaskContext) => R | Promise<R>,
    execution: WorkExecution
  ): TaskFn<R | typeof SKIP> {
    let task: TaskFn<R | typeof SKIP> = async (ctx) => {
      if (execution.rateLimiter !== undefined) await execution.rateLimiter.wait(ctx.signal);
      const observedCtx = this.observeContext(ctx, item, index);
      const transformed = await this.applyTransforms(item, observedCtx);
      if (transformed === SKIP) return SKIP;
      return await terminal(transformed as O, observedCtx);
    };

    if (this.cfg.retry !== undefined) task = run.retry(task, this.cfg.retry);
    if (this.cfg.timeout !== undefined) task = run.timeout(task, this.cfg.timeout);
    if (this.cfg.deadlineAt !== undefined) task = run.deadline(task, this.cfg.deadlineAt);

    return async (ctx) => {
      const nextCtx = { ...ctx, name: `work-item-${index}` };
      try {
        const value = await task(nextCtx);
        if (value === SKIP) {
          this.emitItemDone({
            index,
            item,
            status: "cancelled",
            reason: { kind: "manual", tag: "filtered" },
          });
        } else {
          this.emitItemDone({ index, item, status: "fulfilled", value });
        }
        return value;
      } catch (err) {
        if (err instanceof CancellationError) {
          this.emitItemDone({ index, item, status: "cancelled", reason: err.reason });
        } else {
          this.emitItemDone({ index, item, status: "rejected", error: err });
        }
        throw err;
      }
    };
  }

  private observeContext(ctx: TaskContext, item: I, index: number): TaskContext {
    const handlers = this.cfg.progressHandlers;
    if (handlers === undefined || handlers.length === 0) return ctx;

    return {
      ...ctx,
      report: (progress) => {
        ctx.report(progress);
        const event: WorkProgressEvent<I> = {
          index,
          item,
          taskId: ctx.id,
          ...(progress.pct !== undefined ? { pct: progress.pct } : {}),
          ...(progress.message !== undefined ? { message: progress.message } : {}),
          ...(progress.data !== undefined ? { data: progress.data } : {}),
        };
        for (const handler of handlers) handler(event as WorkProgressEvent<unknown>);
      },
    };
  }

  private emitItemDone(event: WorkItemDoneEvent<I, unknown>): void {
    for (const handler of this.cfg.itemDoneHandlers ?? []) {
      handler(event as WorkItemDoneEvent<unknown, unknown>);
    }
  }

  private async applyTransforms(item: I, ctx: TaskContext): Promise<unknown | typeof SKIP> {
    let current: unknown = item;
    for (const transform of this.cfg.transforms) {
      if (transform.kind === "map") current = await transform.fn(current, ctx);
      else if (transform.kind === "filter") {
        if (!await transform.fn(current, ctx)) return SKIP;
      } else {
        await transform.fn(current, ctx);
      }
    }
    return current;
  }
}

async function toArray<I>(source: Iterable<I> | AsyncIterable<I>): Promise<I[]> {
  const out: I[] = [];
  if (Symbol.asyncIterator in source) {
    for await (const item of source) out.push(item);
  } else {
    for (const item of source) out.push(item);
  }
  return out;
}

function toAsyncIterator<I>(source: Iterable<I> | AsyncIterable<I>): AsyncIterator<I> {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
  const iterator = source[Symbol.iterator]();
  return {
    async next() {
      return iterator.next();
    },
  };
}

function assertConcurrency(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError("positive integer");
  }
}

function assertRateLimit(perSecond: number): void {
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    throw new RangeError("positive finite");
  }
}

function isNotSkipped<R>(value: R | typeof SKIP): value is R {
  return value !== SKIP;
}

function toItemError(index: number, item: unknown, error: unknown): ItemError {
  return { index, item, error, attempts: 1 };
}

interface WorkExecution {
  rateLimiter?: RateLimiter;
}

interface RateLimiter {
  wait(signal: AbortSignal): Promise<void>;
}

function createExecution(cfg: WorkConfig): WorkExecution {
  const rateLimiter = cfg.rateLimitPerSecond !== undefined
    ? createRateLimiter(cfg.rateLimitPerSecond)
    : undefined;
  return rateLimiter === undefined ? {} : { rateLimiter };
}

function createRateLimiter(perSecond: number): RateLimiter {
  const intervalMs = 1_000 / perSecond;
  let nextStart = 0;
  let chain = Promise.resolve();

  return {
    wait(signal) {
      const runWait = async () => {
        /* v8 ignore if -- task timeouts cancel scheduled waits after the wait starts. */
        if (signal.aborted) throw signal.reason;
        const now = Date.now();
        const startAt = Math.max(now, nextStart);
        nextStart = startAt + intervalMs;
        await sleepUntil(startAt, signal);
      };
      const current = chain.then(runWait, runWait);
      chain = current.catch(() => undefined);
      return current;
    },
  };
}

function sleepUntil(at: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, at - Date.now());
  if (delayMs === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    /* v8 ignore if -- rate waits are scheduled before their task signal is aborted. */
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
