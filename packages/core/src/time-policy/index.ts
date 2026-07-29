/**
 * Declarative time policy planner for WorkIt runtime compositions.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The planner computes conservative upper bounds for retry, timeout, deadline,
 * hedge, series, and parallel compositions. It never runs task bodies.
 */

import type { BudgetState, ContextKey, Duration, RetryOpts } from "../types/index.js";
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
  | "retry_budget_exceeded"
  | "retry_budget_snapshot_missing"
  | "retry_exceeds_timeout"
  | "time_exceeds_timeout";

/** One safe, typed planning warning. */
export interface TimePlanWarning {
  readonly code: TimePlanWarningCode;
  readonly message: string;
  readonly estimatedMs?: number;
  readonly limitMs?: number;
  readonly budgetKey?: string;
  readonly requiredRetries?: number;
  readonly remainingRetries?: number;
}

/** Runtime budget snapshot used to assess aggregate retry admission. */
export interface RetryBudgetSnapshot {
  readonly key: ContextKey<BudgetState>;
  readonly state: Readonly<BudgetState>;
}

/** Optional runtime state supplied to a pure time-policy plan. */
export interface TimePlanOptions {
  readonly retryBudgets?: readonly RetryBudgetSnapshot[];
}

/** Aggregate retry demand for one budget key referenced by a policy tree. */
export interface TimePlanRetryBudget {
  readonly key: string;
  readonly required: number;
  readonly limit?: number;
  readonly spent?: number;
  readonly remaining?: number;
  readonly status: "admissible" | "exceeded" | "unverified";
}

/** Planning result for one policy tree. */
export interface TimePlan {
  readonly valid: boolean;
  readonly upperBoundMs: number;
  readonly criticalPathMs: number;
  readonly parallelWorkMs: number;
  readonly attempts: number;
  readonly retryBudgets: readonly TimePlanRetryBudget[];
  readonly warnings: readonly TimePlanWarning[];
}

const MAX_POLICY_DEPTH = 64;

/** Plans a declarative time policy without executing user task bodies. */
export function planTimePolicy(policy: TimePolicy, opts: TimePlanOptions = {}): TimePlan {
  return applyRetryBudgetPlan(plan(policy, 0), policy, opts);
}

/** Computes retry upper bounds using WorkIt's runtime retry semantics. */
export function estimateRetry(
  policy: Pick<RetryTimePolicy, "attempt" | "retry">,
  opts: TimePlanOptions = {},
): TimePlan {
  return applyRetryBudgetPlan(
    estimateRetryAtDepth(policy, 1),
    { type: "retry", ...policy },
    opts,
  );
}

/** Computes hedge upper bounds using WorkIt's staggered duplicate attempts. */
export function estimateHedge(
  policy: Pick<HedgeTimePolicy, "attempt" | "after" | "max">,
  opts: TimePlanOptions = {},
): TimePlan {
  return applyRetryBudgetPlan(
    estimateHedgeAtDepth(policy, 1),
    { type: "hedge", ...policy },
    opts,
  );
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
    retryBudgets: [],
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
    retryBudgets: [],
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
    retryBudgets: [],
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
    retryBudgets: [],
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
    retryBudgets: [],
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
    retryBudgets: [],
    warnings: [{
      code: "empty_composition",
      message: "empty time composition has zero cost",
    }],
  };
}

function applyRetryBudgetPlan(base: TimePlan, policy: TimePolicy, opts: TimePlanOptions): TimePlan {
  const demand = collectRetryBudgetDemand(policy);
  if (demand.size === 0) return base;

  const snapshots = readRetryBudgetSnapshots(opts.retryBudgets ?? []);
  const retryBudgets: TimePlanRetryBudget[] = [];
  const warnings = [...base.warnings];
  let valid = base.valid;

  for (const [key, required] of demand) {
    const state = snapshots.get(key);
    if (state === undefined) {
      valid = false;
      retryBudgets.push({ key, required, status: "unverified" });
      warnings.push({
        code: "retry_budget_snapshot_missing",
        message: "retry budget admission cannot be verified without a matching runtime snapshot",
        budgetKey: key,
        requiredRetries: required,
      });
      continue;
    }

    const remaining = state.limit - state.spent;
    const admissible = required <= remaining;
    if (!admissible) valid = false;
    retryBudgets.push({
      key,
      required,
      limit: state.limit,
      spent: state.spent,
      remaining,
      status: admissible ? "admissible" : "exceeded",
    });
    if (!admissible) {
      warnings.push({
        code: "retry_budget_exceeded",
        message: "declared retry demand exceeds the remaining shared retry budget",
        budgetKey: key,
        requiredRetries: required,
        remainingRetries: remaining,
      });
    }
  }

  return { ...base, valid, retryBudgets, warnings };
}

function collectRetryBudgetDemand(
  policy: TimePolicy,
  multiplier = 1,
  demand = new Map<string, number>(),
): Map<string, number> {
  switch (policy.type) {
    case "series":
    case "parallel":
      for (const child of policy.policies) collectRetryBudgetDemand(child, multiplier, demand);
      break;
    case "retry": {
      const retry = normalizeRetry(policy.retry);
      if (typeof policy.retry !== "number" && policy.retry.retryBudget !== undefined) {
        addRetryDemand(demand, policy.retry.retryBudget.name, boundedProduct(retry.times - 1, multiplier));
      }
      collectRetryBudgetDemand(policy.attempt, boundedProduct(multiplier, retry.times), demand);
      break;
    }
    case "hedge":
      collectRetryBudgetDemand(policy.attempt, boundedProduct(multiplier, policy.max), demand);
      break;
    case "timeout":
    case "deadline":
      collectRetryBudgetDemand(policy.policy, multiplier, demand);
      break;
    case "attempt":
      break;
  }
  return demand;
}

function addRetryDemand(demand: Map<string, number>, key: string, amount: number): void {
  demand.set(key, Math.min(Number.MAX_SAFE_INTEGER, (demand.get(key) ?? 0) + amount));
}

function boundedProduct(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left * right);
}

function readRetryBudgetSnapshots(
  snapshots: readonly RetryBudgetSnapshot[],
): Map<string, Readonly<BudgetState>> {
  const result = new Map<string, Readonly<BudgetState>>();
  for (const snapshot of snapshots) {
    const { limit, spent } = snapshot.state;
    if (!Number.isFinite(limit) || !Number.isFinite(spent) || limit < 0 || spent < 0 || spent > limit) {
      throw new RangeError("retry budget snapshot must have finite non-negative spent <= limit");
    }
    if (result.has(snapshot.key.name)) {
      throw new RangeError(`duplicate retry budget snapshot: ${snapshot.key.name}`);
    }
    result.set(snapshot.key.name, snapshot.state);
  }
  return result;
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
