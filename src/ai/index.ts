/**
 * AI adapter utilities for WorkJS.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This module is provider-neutral: callers bring provider functions, and WorkJS
 * supplies structured ownership, cancellation, token budgeting, and batch
 * failure policy. No network client is imported or initialized here.
 */

import { createBudget } from "../engine/context.js";
import type { CancelReason, Duration, RetryOpts, TaskContext, TaskFn, WorkOutput } from "../types/index.js";
import { CancellationError, CostBudget } from "../types/index.js";
import { work } from "../work/index.js";
import { run } from "../run/index.js";
import { ChannelClosedError, createChannel } from "../channel/index.js";

/** Built-in token budget key for AI companion helpers. */
export const OpenAITokens = createBudget("OpenAITokens", { unit: "tokens" });

/** Built-in tool-call budget key for agent tool execution. */
export const AgentToolCalls = createBudget("AgentToolCalls", { unit: "tool_calls" });

/** Provider contract for embedding one input inside a WorkJS task context. */
export interface EmbeddingProvider<I> {
  embed(input: I, ctx: TaskContext): Promise<readonly number[]>;
  countTokens?: (input: I) => number;
}

/** Provider contract for embedding a batch of inputs inside one task context. */
export interface BatchEmbeddingProvider<I> {
  embedBatch(inputs: readonly I[], ctx: TaskContext): Promise<readonly (readonly number[])[]>;
  countTokens?: (input: I) => number;
}

/** Provider contract for transcribing one chunk inside a WorkJS task context. */
export interface TranscriptionProvider<I> {
  transcribe(input: I, ctx: TaskContext): Promise<string>;
}

/** Options for provider-neutral embedding batches. */
export interface EmbedAllOptions<I> {
  concurrency?: number;
  onError?: "fail" | "continue" | "collect";
  countTokens?: (input: I) => number;
  retry?: number;
  timeout?: Duration;
}

/** Options for bad-batch bisection embedding. */
export interface EmbedBisectionOptions<I> {
  batchSize?: number;
  concurrency?: number;
  onError?: "fail" | "continue";
  countTokens?: (input: I) => number;
  classifyError?: (err: unknown, batch: readonly I[]) => "split" | "fail";
  retry?: number;
  timeout?: Duration;
}

/** Options for signal-aware streaming transcription. */
export interface TranscribeStreamOptions {
  signal?: AbortSignal;
}

/** Options for generic backpressured AI or provider streams. */
export interface StreamWithBackpressureOptions {
  concurrency?: number;
  retry?: number;
  timeout?: Duration;
  signal?: AbortSignal;
}

/** Replayable agent event emitted by `runAgent()`. */
export type AgentEvent =
  | { type: "agent:started"; seq: number; agentId: string; at: number }
  | { type: "agent:tool_started"; seq: number; agentId: string; tool: string; at: number }
  | { type: "agent:tool_succeeded"; seq: number; agentId: string; tool: string; at: number }
  | { type: "agent:tool_failed"; seq: number; agentId: string; tool: string; error: string; at: number }
  | { type: "agent:tool_cancelled"; seq: number; agentId: string; tool: string; reason: CancelReason; at: number }
  | { type: "agent:completed"; seq: number; agentId: string; at: number }
  | { type: "agent:failed"; seq: number; agentId: string; error: string; at: number };

type AgentEventPayload =
  | { type: "agent:started" }
  | { type: "agent:tool_started"; tool: string }
  | { type: "agent:tool_succeeded"; tool: string }
  | { type: "agent:tool_failed"; tool: string; error: string }
  | { type: "agent:tool_cancelled"; tool: string; reason: CancelReason }
  | { type: "agent:completed" }
  | { type: "agent:failed"; error: string };

/** Budget charges and policies for one agent tool call. */
export interface AgentToolOptions {
  tokens?: number;
  cost?: number;
  toolCalls?: number;
  retry?: number | RetryOpts;
  timeout?: Duration;
}

/** Agent-scoped execution contract passed to `runAgent()`. */
export interface AgentScope {
  readonly id: string;
  readonly events: readonly AgentEvent[];
  tool<I, O>(
    name: string,
    input: I,
    fn: (input: I, ctx: TaskContext) => O | Promise<O>,
    opts?: AgentToolOptions
  ): Promise<O>;
}

/** Result returned by `runAgent()`. */
export interface AgentRunResult<R> {
  result: R;
  events: readonly AgentEvent[];
}

/** Provider contract for stream-first LLM helpers. */
export interface LLMStreamProvider<I, O> {
  stream(input: I, ctx: TaskContext): AsyncIterable<O>;
}

/** Options for `streamLLM()`. */
export interface StreamLLMOptions {
  signal?: AbortSignal;
  buffer?: number;
}

const BAD_BATCH_ERROR_BRAND = Symbol.for("workjs.ai.BadBatchError");
let nextAgentId = 0;

/** Error type applications can throw when a provider rejects a mixed-quality batch. */
export class BadBatchError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object"
      && value !== null
      && (value as Record<symbol, unknown>)[BAD_BATCH_ERROR_BRAND] === true;
  }

  constructor(message = "Embedding batch rejected") {
    super(message);
    this.name = "BadBatchError";
    (this as Record<symbol, unknown>)[BAD_BATCH_ERROR_BRAND] = true;
  }
}

/** Wraps one AI task with structured task log events. */
export function wrapAI<T>(provider: string, task: TaskFn<T>): TaskFn<T> {
  return async (ctx) => {
    ctx.log.info("ai task started", { provider });
    try {
      const value = await task(ctx);
      ctx.log.info("ai task succeeded", { provider });
      return value;
    } catch (err) {
      ctx.log.error("ai task failed", { provider, error: errorMessage(err) });
      throw err;
    }
  };
}

/** Runs an agent body with replayable local events and explicit tool contracts. */
export async function runAgent<R>(
  body: (agent: AgentScope, ctx: TaskContext) => R | Promise<R>
): Promise<AgentRunResult<R>> {
  const events: AgentEvent[] = [];
  const agentId = makeAgentId();
  let seq = 0;
  const emit = (event: AgentEventPayload): void => {
    events.push({ ...event, seq: ++seq, agentId, at: Date.now() } as AgentEvent);
  };

  const result = await run.group(async (task) => {
    return await task(async (ctx) => {
      const agent = new AgentScopeImpl(agentId, events, emit, ctx);
      emit({ type: "agent:started" });
      try {
        const value = await body(agent, ctx);
        emit({ type: "agent:completed" });
        return value;
      } catch (err) {
        emit({ type: "agent:failed", error: errorMessage(err) });
        throw err;
      }
    }, { name: "ai.agent", kind: "llm" });
  });

  return { result, events };
}

/** Embeds all inputs with bounded concurrency and optional token budgeting. */
export async function embedAll<I>(
  inputs: Iterable<I> | AsyncIterable<I>,
  provider: EmbeddingProvider<I>,
  opts: EmbedAllOptions<I> = {}
): Promise<WorkOutput<readonly number[]>> {
  const countTokens = opts.countTokens ?? provider.countTokens ?? (() => 0);
  let builder = work(inputs)
    .inParallel(opts.concurrency ?? 4)
    .onError(opts.onError ?? "fail");

  if (opts.retry !== undefined) builder = builder.withRetry(opts.retry);
  if (opts.timeout !== undefined) builder = builder.withTimeout(opts.timeout);

  return await builder.do(async (input, ctx) => {
    const tokens = countTokens(input);
    if (tokens > 0) ctx.consume(OpenAITokens, tokens);
    return await provider.embed(input, ctx);
  });
}

/** Embeds batches and bisects provider-rejected bad batches down to item errors. */
export async function embedAllBisection<I>(
  inputs: Iterable<I> | AsyncIterable<I>,
  provider: BatchEmbeddingProvider<I>,
  opts: EmbedBisectionOptions<I> = {}
): Promise<WorkOutput<readonly number[]>> {
  const items = await toArray(inputs);
  const batchSize = opts.batchSize ?? 64;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("embedAllBisection batchSize must be a positive integer");
  }

  const classifyError = opts.classifyError ?? defaultBatchErrorClassifier;
  const countTokens = opts.countTokens ?? provider.countTokens ?? (() => 0);
  const chunks = chunkIndexed(items, batchSize);
  const mode = opts.onError ?? "fail";
  const chunkTasks = chunks.map((chunk) => {
    let task: TaskFn<BisectionChunkResult<I>> = async (ctx) => {
      const tokenCost = chunk.reduce((sum, item) => sum + countTokens(item.value), 0);
      if (tokenCost > 0) ctx.consume(OpenAITokens, tokenCost);

      const results = new Map<number, readonly number[]>();
      const errors: Array<{ index: number; item: I; error: unknown }> = [];
      await embedIndexedBatch(chunk, provider, ctx, classifyError, results, errors);
      return { results, errors };
    };
    if (opts.retry !== undefined) task = run.retry(task, opts.retry);
    if (opts.timeout !== undefined) task = run.timeout(task, opts.timeout);

    return async (ctx: TaskContext): Promise<BisectionChunkResult<I>> => {
      try {
        return await task(ctx);
      } catch (err) {
        if (err instanceof CancellationError) throw err;
        if (mode === "fail") throw err;
        return {
          results: new Map(),
          errors: [{ index: chunk[0]!.index, item: chunk[0]!.value, error: err }],
        };
      }
    };
  });

  const results: Array<readonly number[] | undefined> = [];
  const errors: Array<{ index: number; item: unknown; error: unknown; attempts: number }> = [];
  const chunkResults = await run.pool(opts.concurrency ?? 2, chunkTasks);
  for (const chunk of chunkResults) {
    for (const [index, vector] of chunk.results) {
      results[index] = vector;
    }
    for (const error of chunk.errors) {
      errors.push({ ...error, attempts: 1 });
    }
  }
  errors.sort((a, b) => a.index - b.index);

  if (mode === "fail" && errors.length > 0) {
    throw errors[0]!.error;
  }
  return {
    mode: "continue",
    results: results.filter((value): value is readonly number[] => value !== undefined),
    errors,
  };
}

/** Transcribes an async stream of chunks sequentially with one scope per chunk. */
export async function* transcribeStream<I>(
  chunks: AsyncIterable<I>,
  provider: TranscriptionProvider<I>,
  opts: TranscribeStreamOptions = {}
): AsyncIterable<string> {
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    while (true) {
      throwIfAborted(opts.signal);
      const next = await nextWithAbort(iterator, opts.signal);
      if (next.done === true) break;
      const chunk = next.value;
      yield await run.group(async (task) => {
        return await task(async (ctx) => {
          const signal = opts.signal === undefined
            ? ctx.signal
            : AbortSignal.any([ctx.signal, opts.signal]);
          return await provider.transcribe(chunk, { ...ctx, signal });
        }, {
          name: "ai.transcribe",
          kind: "llm",
        });
      });
    }
  } finally {
    await iterator.return?.();
  }
}

/** Streams provider work with bounded concurrency, retry, timeout, and cancellation. */
export function streamWithBackpressure<I, O>(
  inputs: Iterable<I> | AsyncIterable<I>,
  fn: (input: I, ctx: TaskContext) => O | Promise<O>,
  opts: StreamWithBackpressureOptions = {}
): AsyncIterable<O> {
  let builder = work(opts.signal === undefined ? inputs : abortableIterable(inputs, opts.signal))
    .inParallel(opts.concurrency ?? 4);

  if (opts.retry !== undefined) builder = builder.withRetry(opts.retry);
  if (opts.timeout !== undefined) builder = builder.withTimeout(opts.timeout);

  return builder
    .map(async (input, ctx) => {
      const signal = opts.signal === undefined
        ? ctx.signal
        : AbortSignal.any([ctx.signal, opts.signal]);
      throwIfAborted(signal);
      return await fn(input, { ...ctx, signal });
    })
    .stream();
}

/** Streams one LLM provider response while keeping provider work inside WorkJS ownership. */
export function streamLLM<I, O>(
  input: I,
  provider: LLMStreamProvider<I, O>,
  opts: StreamLLMOptions = {}
): AsyncIterable<O> {
  return streamLLMGenerator(input, provider, opts);
}

class AgentScopeImpl implements AgentScope {
  constructor(
    readonly id: string,
    readonly events: readonly AgentEvent[],
    private readonly emit: (event: AgentEventPayload) => void,
    private readonly ctx: TaskContext
  ) {}

  async tool<I, O>(
    name: string,
    input: I,
    fn: (input: I, ctx: TaskContext) => O | Promise<O>,
    opts: AgentToolOptions = {}
  ): Promise<O> {
    this.emit({ type: "agent:tool_started", tool: name });
    try {
      const charge = (key: typeof OpenAITokens | typeof CostBudget | typeof AgentToolCalls, amount?: number): void => {
        if (amount !== undefined && amount > 0) this.ctx.consume(key, amount);
      };
      charge(OpenAITokens, opts.tokens);
      charge(CostBudget, opts.cost);
      charge(AgentToolCalls, opts.toolCalls);

      let task: TaskFn<O> = async (ctx) => await fn(input, { ...ctx, kind: "tool", name: `agent.tool.${name}` });
      if (opts.retry !== undefined) task = run.retry(task, opts.retry);
      if (opts.timeout !== undefined) task = run.timeout(task, opts.timeout);
      const value = await task(this.ctx);
      this.emit({ type: "agent:tool_succeeded", tool: name });
      return value;
    } catch (err) {
      if (err instanceof CancellationError) {
        this.emit({ type: "agent:tool_cancelled", tool: name, reason: err.reason });
      } else {
        this.emit({ type: "agent:tool_failed", tool: name, error: errorMessage(err) });
      }
      throw err;
    }
  }
}

async function* streamLLMGenerator<I, O>(
  input: I,
  provider: LLMStreamProvider<I, O>,
  opts: StreamLLMOptions
): AsyncIterable<O> {
  const channel = createChannel<O>({ capacity: opts.buffer ?? 1 });
  let producerError: unknown;

  const producer = run.group(async (task) => {
    await task(async (ctx) => {
      const signal = opts.signal === undefined
        ? ctx.signal
        : AbortSignal.any([ctx.signal, opts.signal]);
      try {
        for await (const chunk of provider.stream(input, { ...ctx, name: "ai.llm.stream", kind: "llm", signal })) {
          await channel.send(chunk, { signal });
        }
        channel.close();
      } catch (err) {
        producerError = err;
        channel.close(err);
        if (!(err instanceof ChannelClosedError)) throw err;
      }
    }, { name: "ai.llm.stream", kind: "llm" });
  });

  try {
    while (true) {
      const next = opts.signal === undefined ? await channel.receive() : await channel.receive({ signal: opts.signal });
      if (next.done) {
        if (next.reason !== undefined) throw next.reason;
        break;
      }
      yield next.value;
    }
  } finally {
    channel.close(new CancellationError({ kind: "manual", tag: "llm_stream_closed" }));
    await producer.catch((err: unknown) => {
      if (err instanceof ChannelClosedError || err === producerError) return;
      throw err;
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeAgentId(): string {
  nextAgentId++;
  return `agent-${nextAgentId}`;
}

interface IndexedInput<I> {
  index: number;
  value: I;
}

interface BisectionChunkResult<I> {
  results: Map<number, readonly number[]>;
  errors: Array<{ index: number; item: I; error: unknown }>;
}

async function embedIndexedBatch<I>(
  batch: readonly IndexedInput<I>[],
  provider: BatchEmbeddingProvider<I>,
  ctx: TaskContext,
  classifyError: (err: unknown, batch: readonly I[]) => "split" | "fail",
  results: Map<number, readonly number[]>,
  errors: Array<{ index: number; item: I; error: unknown }>
): Promise<void> {
  throwIfAborted(ctx.signal);
  try {
    const vectors = await provider.embedBatch(batch.map((item) => item.value), ctx);
    if (vectors.length !== batch.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`);
    }
    for (let index = 0; index < batch.length; index++) {
      results.set(batch[index]!.index, vectors[index]!);
    }
  } catch (err) {
    if (batch.length > 1 && classifyError(err, batch.map((item) => item.value)) === "split") {
      const midpoint = Math.ceil(batch.length / 2);
      await embedIndexedBatch(batch.slice(0, midpoint), provider, ctx, classifyError, results, errors);
      await embedIndexedBatch(batch.slice(midpoint), provider, ctx, classifyError, results, errors);
      return;
    }
    if (batch.length === 1) {
      errors.push({ index: batch[0]!.index, item: batch[0]!.value, error: err });
      return;
    }
    throw err;
  }
}

function defaultBatchErrorClassifier(err: unknown): "split" | "fail" {
  return err instanceof BadBatchError ? "split" : "fail";
}

function chunkIndexed<I>(items: readonly I[], size: number): Array<Array<IndexedInput<I>>> {
  const chunks: Array<Array<IndexedInput<I>>> = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size).map((value, offset) => ({ index: index + offset, value })));
  }
  return chunks;
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

async function* abortableIterable<I>(
  source: Iterable<I> | AsyncIterable<I>,
  signal: AbortSignal
): AsyncIterable<I> {
  throwIfAborted(signal);
  if (Symbol.asyncIterator in source) {
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await nextWithAbort(iterator, signal);
        if (next.done === true) break;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
    return;
  }

  for (const item of source) {
    throwIfAborted(signal);
    yield item;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

function nextWithAbort<I>(
  iterator: AsyncIterator<I>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<I>> {
  if (signal === undefined) return iterator.next();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}
