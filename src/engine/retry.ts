/**
 * Shared retry policy helpers for WorkJS runtime wrappers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Retry policy validation and delay calculation live outside the scope engine
 * so task ownership stays separate from runtime resilience wrappers.
 */

import type { RetryOpts } from "../types/index.js";
import { MAX_RETRY_ATTEMPTS } from "../types/index.js";
import { parseDuration } from "./duration.js";

export type NormalizedRetryPolicy = Required<Pick<RetryOpts, "times" | "initialDelay" | "maxDelay" | "jitter" | "retryIf">> & {
  backoff: NonNullable<RetryOpts["backoff"]>;
};

export function validateRetryPolicy(opts: number | RetryOpts): void {
  const times = typeof opts === "number" ? opts : opts.times;
  if (!Number.isInteger(times) || times < 1 || times > MAX_RETRY_ATTEMPTS) {
    throw new RangeError(`retry attempts must be an integer between 1 and ${MAX_RETRY_ATTEMPTS}`);
  }
}

export function normalizeRetry(opts: number | RetryOpts): NormalizedRetryPolicy {
  validateRetryPolicy(opts);
  const raw = typeof opts === "number" ? { times: opts } : opts;
  return {
    times: raw.times,
    backoff: raw.backoff ?? "exponential",
    initialDelay: raw.initialDelay ?? 100,
    maxDelay: raw.maxDelay ?? 30_000,
    jitter: raw.jitter ?? true,
    retryIf: raw.retryIf ?? (() => true),
  };
}

export function computeRetryDelay(attempt: number, policy: NormalizedRetryPolicy): number {
  return computeBackoffDelay(attempt, policy.backoff, parseDuration(policy.initialDelay), parseDuration(policy.maxDelay), policy.jitter);
}

export function computeBackoffDelay(
  attempt: number,
  backoff: RetryOpts["backoff"] = "fixed",
  initialMs = 100,
  maxMs = 30_000,
  jitter = false
): number {
  let delay: number;
  if (typeof backoff === "function") delay = parseDuration(backoff(attempt));
  else if (backoff === "linear") delay = initialMs * attempt;
  else if (backoff === "exponential") delay = initialMs * Math.pow(2, attempt - 1);
  else delay = initialMs;
  delay = Math.min(delay, maxMs);
  return jitter ? delay * (0.5 + Math.random() * 0.5) : delay;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
