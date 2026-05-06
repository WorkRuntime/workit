/**
 * AI adapter utilities for WorkJS.
 *
 * @author Admilson B. F. Cossa
 *
 * This module is provider-neutral: callers bring provider functions, and WorkJS
 * supplies structured ownership, cancellation, token budgeting, and batch
 * failure policy. No network client is imported or initialized here.
 */

import { createBudget } from "../engine/context.js";
import type { Duration, TaskContext, TaskFn, WorkOutput } from "../types/index.js";
import { work } from "../work/index.js";
import { run } from "../run/index.js";

/** Built-in token budget key for AI companion helpers. */
export const OpenAITokens = createBudget("OpenAITokens", { unit: "tokens" });

/** Provider contract for embedding one input inside a WorkJS task context. */
export interface EmbeddingProvider<I> {
  embed(input: I, ctx: TaskContext): Promise<readonly number[]>;
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

/** Transcribes an async stream of chunks sequentially with one scope per chunk. */
export async function* transcribeStream<I>(
  chunks: AsyncIterable<I>,
  provider: TranscriptionProvider<I>
): AsyncIterable<string> {
  for await (const chunk of chunks) {
    yield await run.group(async (task) => {
      return await task(async (ctx) => provider.transcribe(chunk, ctx), {
        name: "ai.transcribe",
        kind: "llm",
      });
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
