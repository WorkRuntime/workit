/**
 * Declarative time policy planner for WorkIt runtime compositions.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The planner computes conservative upper bounds for retry, timeout, deadline,
 * hedge, series, and parallel compositions. It never runs task bodies.
 */

import type { Duration, RetryOpts } from "../types/index.js";
import { parseDuration } from "../engine/duration.js";
import { normalizeRetry } from "../engine/retry.js";

/** Leaf policy representing one bounded task attempt. */
export interface AttemptTimePolicy {
  readonly type: "attempt";
  readonly duration: Duration;
  readonly label?: string;
}

/** Sequential composition: every child policy must settle in order. */
export interface SeriesTimePolicy {
  readonly type: "series";
  readonly policies: readonly TimePolicy[];
}

/** Parallel composition: all child policies are active together. */
export interface ParallelTimePolicy {
  readonly type: "parallel";
  readonly policies: readonly TimePolicy[];
}

/** Retry composition aligned with `run.retry` delay semantics. */
export interface RetryTimePolicy {
  readonly type: "retry";
  readonly attempt: TimePolicy;
  readonly retry: number | RetryOpts;
}

/** Hedge composition aligned with `run.hedge` stagger semantics. */
export interface HedgeTimePolicy {
  readonly type: "hedge";
  readonly attempt: TimePolicy;
  readonly after: Duration;
  readonly max: number;
}

/** Timeout composition that can truncate an inner policy. */
export interface TimeoutTimePolicy {
  readonly type: "timeout";
  readonly timeout: Duration;
  readonly policy: TimePolicy;
}

/** Deadline composition evaluated against an explicit or current clock. */
export interface DeadlineTimePolicy {
  readonly type: "deadline";
  readonly deadlineAt: number | Date;
  readonly now?: number;
  readonly policy: TimePolicy;
}

/** Supported declarative time policy tree. */
export type TimePolicy =
  | AttemptTimePolicy
  | SeriesTimePolicy
  | ParallelTimePolicy
  | RetryTimePolicy
  | HedgeTimePolicy
  | TimeoutTimePolicy
  | DeadlineTimePolicy;

/** Stable warning codes returned by the planner. */
export type TimePlanWarningCode =
  | "deadline_infeasible"
  | "dynamic_backoff_upper_bound"
  | "empty_composition"
  | "hedge_exceeds_timeout"
  | "jitter_upper_bound"
  | "retry_exceeds_timeout"
  | "time_exceeds_timeout";

/** One safe, typed planning warning. */
export interface TimePlanWarning {
  readonly code: TimePlanWarningCode;
  readonly message: string;
  readonly estimatedMs?: number;
  readonly limitMs?: number;
}

/** Planning result for one policy tree. */
export interface TimePlan {
  readonly valid: boolean;
  readonly upperBoundMs: number;
  readonly criticalPathMs: number;
  readonly parallelWorkMs: number;
  readonly attempts: number;
  readonly warnings: readonly TimePlanWarning[];
}

const MAX_POLICY_DEPTH = 64;

/** Plans a declarative time policy without executing user task bodies. */
export function planTimePolicy(policy: TimePolicy): TimePlan {
  return plan(policy, 0);
}

/** Computes retry upper bounds using WorkIt's runtime retry semantics. */
export function estimateRetry(policy: Pick<RetryTimePolicy, "attempt" | "retry">): TimePlan {
  return estimateRetryAtDepth(policy, 1);
}

/** Computes hedge upper bounds using WorkIt's staggered duplicate attempts. */
export function estimateHedge(policy: Pick<HedgeTimePolicy, "attempt" | "after" | "max">): TimePlan {
  return estimateHedgeAtDepth(policy, 1);
}

function estimateRetryAtDepth(policy: Pick<RetryTimePolicy, "attempt" | "retry">, depth: number): TimePlan {
  const attemptPlan = plan(policy.attempt, depth);
  const retry = normalizeRetry(policy.retry);
  const warnings: TimePlanWarning[] = [...attemptPlan.warnings];
  let delayMs = 0;

  for (let attempt = 1; attempt < retry.times; attempt++) {
    const plannedDelay = estimateRetryDelay(attempt, retry);
    delayMs += plannedDelay.delayMs;
    if (plannedDelay.warning !== undefined) warnings.push(plannedDelay.warning);
  }

  if (retry.jitter) {
    warnings.push({
      code: "jitter_upper_bound",
      message: "retry jitter is planned with the maximum non-jittered delay as an upper bound",
    });
  }

  const upperBoundMs = attemptPlan.upperBoundMs * retry.times + delayMs;
  return {
    valid: attemptPlan.valid,
    upperBoundMs,
    criticalPathMs: upperBoundMs,
    parallelWorkMs: attemptPlan.parallelWorkMs * retry.times,
    attempts: attemptPlan.attempts * retry.times,
    warnings,
  };
}

function estimateHedgeAtDepth(policy: Pick<HedgeTimePolicy, "attempt" | "after" | "max">, depth: number): TimePlan {
  if (!Number.isInteger(policy.max) || policy.max < 1) throw new RangeError("hedge max must be a positive integer");

  const attemptPlan = plan(policy.attempt, depth);
  const afterMs = parseDuration(policy.after);
  const upperBoundMs = attemptPlan.upperBoundMs + afterMs * (policy.max - 1);

  return {
    valid: attemptPlan.valid,
    upperBoundMs,
    criticalPathMs: upperBoundMs,
    parallelWorkMs: attemptPlan.parallelWorkMs * policy.max,
    attempts: attemptPlan.attempts * policy.max,
    warnings: attemptPlan.warnings,
  };
}

function plan(policy: TimePolicy, depth: number): TimePlan {
  if (depth > MAX_POLICY_DEPTH) throw new RangeError("time policy depth exceeded");

  switch (policy.type) {
    case "attempt":
      return leafPlan(parseDuration(policy.duration));
    case "series":
      return combineSeries(policy.policies, depth);
    case "parallel":
      return combineParallel(policy.policies, depth);
    case "retry":
      return estimateRetryAtDepth(policy, depth + 1);
    case "hedge":
      return estimateHedgeAtDepth(policy, depth + 1);
    case "timeout":
      return planTimeout(policy, depth);
    case "deadline":
      return planDeadline(policy, depth);
  }
}

function leafPlan(durationMs: number): TimePlan {
  return {
    valid: true,
    upperBoundMs: durationMs,
    criticalPathMs: durationMs,
    parallelWorkMs: durationMs,
    attempts: 1,
    warnings: [],
  };
}

function combineSeries(policies: readonly TimePolicy[], depth: number): TimePlan {
  if (policies.length === 0) return emptyPlan();
  const children = policies.map((child) => plan(child, depth + 1));
  return {
    valid: children.every((child) => child.valid),
    upperBoundMs: children.reduce((total, child) => total + child.upperBoundMs, 0),
    criticalPathMs: children.reduce((total, child) => total + child.criticalPathMs, 0),
    parallelWorkMs: children.reduce((total, child) => total + child.parallelWorkMs, 0),
    attempts: children.reduce((total, child) => total + child.attempts, 0),
    warnings: children.flatMap((child) => child.warnings),
  };
}

function combineParallel(policies: readonly TimePolicy[], depth: number): TimePlan {
  if (policies.length === 0) return emptyPlan();
  const children = policies.map((child) => plan(child, depth + 1));
  return {
    valid: children.every((child) => child.valid),
    upperBoundMs: Math.max(...children.map((child) => child.upperBoundMs)),
    criticalPathMs: Math.max(...children.map((child) => child.criticalPathMs)),
    parallelWorkMs: children.reduce((total, child) => total + child.parallelWorkMs, 0),
    attempts: children.reduce((total, child) => total + child.attempts, 0),
    warnings: children.flatMap((child) => child.warnings),
  };
}

function emptyPlan(): TimePlan {
  return {
    valid: true,
    upperBoundMs: 0,
    criticalPathMs: 0,
    parallelWorkMs: 0,
    attempts: 0,
    warnings: [{
      code: "empty_composition",
      message: "empty time composition has zero cost",
    }],
  };
}

function planTimeout(policy: TimeoutTimePolicy, depth: number): TimePlan {
  const inner = plan(policy.policy, depth + 1);
  const timeoutMs = parseDuration(policy.timeout);
  if (inner.upperBoundMs <= timeoutMs) return inner;

  const containedTypes = collectPolicyTypes(policy.policy);
  const code = containedTypes.has("retry")
    ? "retry_exceeds_timeout"
    : containedTypes.has("hedge")
      ? "hedge_exceeds_timeout"
      : "time_exceeds_timeout";

  return {
    ...inner,
    upperBoundMs: timeoutMs,
    criticalPathMs: Math.min(inner.criticalPathMs, timeoutMs),
    warnings: [
      ...inner.warnings,
      {
        code,
        message: "inner time policy exceeds timeout and will be truncated by runtime cancellation",
        estimatedMs: inner.upperBoundMs,
        limitMs: timeoutMs,
      },
    ],
  };
}

function planDeadline(policy: DeadlineTimePolicy, depth: number): TimePlan {
  const inner = plan(policy.policy, depth + 1);
  const deadlineAt = typeof policy.deadlineAt === "number" ? policy.deadlineAt : policy.deadlineAt.getTime();
  const now = policy.now ?? Date.now();
  const remainingMs = Math.max(0, deadlineAt - now);
  if (inner.upperBoundMs <= remainingMs) return inner;

  return {
    ...inner,
    valid: false,
    upperBoundMs: remainingMs,
    criticalPathMs: Math.min(inner.criticalPathMs, remainingMs),
    warnings: [
      ...inner.warnings,
      {
        code: "deadline_infeasible",
        message: "inner time policy cannot fit before the declared deadline",
        estimatedMs: inner.upperBoundMs,
        limitMs: remainingMs,
      },
    ],
  };
}

function collectPolicyTypes(policy: TimePolicy, types = new Set<TimePolicy["type"]>()): Set<TimePolicy["type"]> {
  types.add(policy.type);
  switch (policy.type) {
    case "series":
    case "parallel":
      for (const child of policy.policies) collectPolicyTypes(child, types);
      return types;
    case "retry":
    case "hedge":
      collectPolicyTypes(policy.attempt, types);
      return types;
    case "timeout":
    case "deadline":
      collectPolicyTypes(policy.policy, types);
      return types;
    case "attempt":
      return types;
  }
}

function estimateRetryDelay(
  attempt: number,
  policy: ReturnType<typeof normalizeRetry>,
): { delayMs: number; warning?: TimePlanWarning } {
  const initialMs = parseDuration(policy.initialDelay);
  const maxMs = parseDuration(policy.maxDelay);
  if (typeof policy.backoff === "function") {
    return {
      delayMs: maxMs,
      warning: {
        code: "dynamic_backoff_upper_bound",
        message: "dynamic retry backoff functions are not executed by the planner; maxDelay is used as an upper bound",
        estimatedMs: maxMs,
      },
    };
  }

  const rawDelay = policy.backoff === "linear"
    ? initialMs * attempt
    : policy.backoff === "exponential"
      ? initialMs * Math.pow(2, attempt - 1)
      : initialMs;

  return { delayMs: Math.min(rawDelay, maxMs) };
}
