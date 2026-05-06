/**
 * Work builder - fluent bounded batch execution.
 *
 * @author Admilson B. F. Cossa
 *
 * The builder keeps conservative defaults: sequential execution, no retry, no
 * timeout, and fail-fast error handling unless the caller explicitly opts into
 * a different policy.
 */

import type {
  Duration,
  ItemError,
  RetryOpts,
  Settled,
  TaskContext,
  TaskFn,
  WorkBuilder,
  WorkFactory,
  WorkOutput,
} from "../types/index.js";
import { CancellationError } from "../types/index.js";
import { run } from "../run/index.js";

type Transform =
  | { kind: "map"; fn: (item: unknown, ctx: TaskContext) => unknown | Promise<unknown> }
  | { kind: "filter"; fn: (item: unknown, ctx: TaskContext) => boolean | Promise<boolean> }
  | { kind: "tap"; fn: (item: unknown, ctx: TaskContext) => void | Promise<void> };

interface WorkConfig {
  concurrency?: number;
  retry?: number | RetryOpts;
  timeout?: Duration;
  deadlineAt?: number;
  errorMode?: "fail" | "continue" | "collect";
  transforms: Transform[];
}

const SKIP = Symbol("work.skip");

/** Creates a fluent builder over an iterable or async iterable source. */
export const work: WorkFactory = <I>(items: Iterable<I> | AsyncIterable<I>) =>
  new WorkBuilderImpl<I, I>(items, { transforms: [] });

class WorkBuilderImpl<I, O> implements WorkBuilder<I, O> {
  constructor(
    private readonly source: Iterable<I> | AsyncIterable<I>,
    private readonly cfg: WorkConfig
  ) {}

  inParallel(n: number): WorkBuilder<I, O> {
    assertConcurrency(n);
    return new WorkBuilderImpl<I, O>(this.source, { ...this.cfg, concurrency: n });
  }

  inSeries(): WorkBuilder<I, O> {
    return this.inParallel(1);
  }

  withConcurrencyLimit(n: number): WorkBuilder<I, O> {
    return this.inParallel(n);
  }

  withRetry(opts: number | RetryOpts): WorkBuilder<I, O> {
    return new WorkBuilderImpl<I, O>(this.source, { ...this.cfg, retry: opts });
  }

  withTimeout(duration: Duration): WorkBuilder<I, O> {
    return new WorkBuilderImpl<I, O>(this.source, { ...this.cfg, timeout: duration });
  }

  withDeadline(at: number | Date): WorkBuilder<I, O> {
    const deadlineAt = typeof at === "number" ? at : at.getTime();
    return new WorkBuilderImpl<I, O>(this.source, { ...this.cfg, deadlineAt });
  }

  onError(strategy: "fail" | "continue" | "collect"): WorkBuilder<I, O> {
    return new WorkBuilderImpl<I, O>(this.source, { ...this.cfg, errorMode: strategy });
  }

  map<R>(fn: (item: O, ctx: TaskContext) => R | Promise<R>): WorkBuilder<I, R> {
    return new WorkBuilderImpl<I, R>(this.source, {
      ...this.cfg,
      transforms: [...this.cfg.transforms, {
        kind: "map",
        fn: fn as (item: unknown, ctx: TaskContext) => unknown | Promise<unknown>,
      }],
    });
  }

  filter(fn: (item: O, ctx: TaskContext) => boolean | Promise<boolean>): WorkBuilder<I, O> {
    return new WorkBuilderImpl<I, O>(this.source, {
      ...this.cfg,
      transforms: [...this.cfg.transforms, {
        kind: "filter",
        fn: fn as (item: unknown, ctx: TaskContext) => boolean | Promise<boolean>,
      }],
    });
  }

  tap(fn: (item: O, ctx: TaskContext) => void | Promise<void>): WorkBuilder<I, O> {
    return new WorkBuilderImpl<I, O>(this.source, {
      ...this.cfg,
      transforms: [...this.cfg.transforms, {
        kind: "tap",
        fn: fn as (item: unknown, ctx: TaskContext) => void | Promise<void>,
      }],
    });
  }

  async do<R>(fn: (item: O, ctx: TaskContext) => R | Promise<R>): Promise<WorkOutput<R>> {
    const items = await toArray(this.source);
    const mode = this.cfg.errorMode ?? "fail";
    const tasks = items.map((item, index) => this.makeTask(item, index, fn));

    if (mode === "fail") {
      const raw = await run.pool(this.cfg.concurrency ?? 1, tasks);
      return { mode: "fail", results: raw.filter(isNotSkipped) };
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
        return {
          status: "rejected",
          reason: toItemError(index, items[index], err),
        } satisfies Settled<R>;
      }
    });

    const settled = await run.pool(this.cfg.concurrency ?? 1, settledTasks);
    if (mode === "collect") return { mode: "collect", results: settled };

    const results: R[] = [];
    const errors: ItemError[] = [];
    for (const item of settled) {
      if (item.status === "fulfilled") results.push(item.value);
      else if (item.status === "rejected") errors.push(item.reason as ItemError);
    }
    return { mode: "continue", results, errors };
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
    let nextKey = 0;

    while (true) {
      const tasks: TaskFn<O | typeof SKIP>[] = [];
      while (tasks.length < concurrency) {
        const next = await iterator.next();
        if (next.done === true) break;
        tasks.push(this.makeTask<O>(next.value, nextKey++, (item) => item));
      }
      if (tasks.length === 0) break;

      for (const value of await run.pool(concurrency, tasks)) {
        if (value !== SKIP) yield value;
      }
    }
  }

  private makeTask<R>(
    item: I,
    index: number,
    terminal: (item: O, ctx: TaskContext) => R | Promise<R>
  ): TaskFn<R | typeof SKIP> {
    let task: TaskFn<R | typeof SKIP> = async (ctx) => {
      const transformed = await this.applyTransforms(item, ctx);
      if (transformed === SKIP) return SKIP;
      return await terminal(transformed as O, ctx);
    };

    if (this.cfg.retry !== undefined) task = run.retry(task, this.cfg.retry);
    if (this.cfg.timeout !== undefined) task = run.timeout(task, this.cfg.timeout);
    if (this.cfg.deadlineAt !== undefined) task = run.deadline(task, this.cfg.deadlineAt);

    return async (ctx) => task({ ...ctx, name: `work-item-${index}` });
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
    throw new RangeError("work().inParallel(n) requires a positive integer");
  }
}

function isNotSkipped<R>(value: R | typeof SKIP): value is R {
  return value !== SKIP;
}

function toItemError(index: number, item: unknown, error: unknown): ItemError {
  return { index, item, error, attempts: 1 };
}
