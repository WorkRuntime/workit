/**
 * Browser and edge unsupported-runtime entrypoint.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * WorkIt currently requires Node.js async context support for its structured
 * concurrency guarantees. Browser and edge runtimes must use a future dedicated
 * runtime instead of silently receiving weaker semantics.
 */

const MESSAGE =
  "WorkIt requires Node.js async context. Browser and edge need a dedicated runtime split.";

type UnsupportedFunction = (..._args: readonly unknown[]) => never;

/** Error thrown when a browser or edge bundle calls a Node-only WorkIt API. */
export class UnsupportedRuntimeError extends Error {
  constructor(apiName: string) {
    super(`${apiName} is unavailable in this WorkIt runtime. ${MESSAGE}`);
    this.name = "UnsupportedRuntimeError";
  }
}

/** Cancellation error shape preserved for defensive browser bundles. */
export class CancellationError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown = { kind: "manual", tag: "unsupported-runtime" }) {
    super("WorkIt operation cancelled");
    this.name = "CancellationError";
    this.reason = reason;
  }
}

/** Timeout error shape preserved for defensive browser bundles. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`WorkIt operation timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Budget error shape preserved for defensive browser bundles. */
export class BudgetExceededError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("WorkIt budget exceeded");
    this.name = "BudgetExceededError";
    this.reason = reason;
  }
}

/** Aggregate error shape preserved for defensive browser bundles. */
export class WorkAggregateError extends AggregateError {
  constructor(errors: Iterable<unknown>, message = "WorkIt aggregate error") {
    super(errors, message);
    this.name = "WorkAggregateError";
  }
}

/** Error applications can use to mark provider-rejected mixed embedding batches. */
export class BadBatchError extends Error {
  constructor(message = "Embedding batch rejected") {
    super(message);
    this.name = "BadBatchError";
  }
}

export const CostBudget = budgetKey("CostBudget", "usd");
export const TelemetryBudget = budgetKey("TelemetryBudget", "events");
export const TokenBudget = budgetKey("TokenBudget", "tokens");
export const LatencyBudget = budgetKey("LatencyBudget", "ms");
export const OpenAITokens = budgetKey("OpenAITokens", "tokens");

export const group = unsupportedFunction("group");
export const getCurrentScope = unsupportedFunction("getCurrentScope");
export const renderTree = unsupportedFunction("renderTree");
export const createContextKey = unsupportedFunction("createContextKey");
export const createBudget = unsupportedFunction("createBudget");
export const ContextBagImpl = unsupportedClass("ContextBagImpl");
export const work = unsupportedFunction("work");
export const embedAll = unsupportedFunction("embedAll");
export const embedAllBisection = unsupportedFunction("embedAllBisection");
export const streamWithBackpressure = unsupportedFunction("streamWithBackpressure");
export const transcribeStream = unsupportedFunction("transcribeStream");
export const wrapAI = unsupportedFunction("wrapAI");
export const offload = unsupportedFunction("offload");

export const run = Object.freeze({
  all: unsupportedFunction("run.all"),
  allSettled: unsupportedFunction("run.allSettled"),
  any: unsupportedFunction("run.any"),
  race: unsupportedFunction("run.race"),
  series: unsupportedFunction("run.series"),
  pool: unsupportedFunction("run.pool"),
  timeout: unsupportedFunction("run.timeout"),
  deadline: unsupportedFunction("run.deadline"),
  retry: unsupportedFunction("run.retry"),
  hedge: unsupportedFunction("run.hedge"),
  fallback: unsupportedFunction("run.fallback"),
  circuitBreaker: unsupportedFunction("run.circuitBreaker"),
  group: unsupportedFunction("run.group"),
  scope: unsupportedFunction("run.scope"),
  background: unsupportedFunction("run.background"),
  detached: unsupportedFunction("run.detached"),
  supervise: unsupportedFunction("run.supervise"),
  context: Object.freeze({
    current: unsupportedFunction("run.context.current"),
    with: unsupportedFunction("run.context.with"),
    get: unsupportedFunction("run.context.get"),
    budget: unsupportedFunction("run.context.budget"),
  }),
});

function unsupportedFunction(apiName: string): UnsupportedFunction {
  return (..._args: readonly unknown[]) => {
    throw new UnsupportedRuntimeError(apiName);
  };
}

function unsupportedClass(apiName: string): new (..._args: readonly unknown[]) => never {
  return class {
    constructor(..._args: readonly unknown[]) {
      throw new UnsupportedRuntimeError(apiName);
    }
  } as new (..._args: readonly unknown[]) => never;
}

function budgetKey(name: string, unit: string): Readonly<{ name: string; unit: string }> {
  return Object.freeze({ name, unit });
}
