/**
 * Correctness evidence: nested time-policy composition.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This proof checks recursive composition laws for generated nested
 * time-policy trees against the public `planTimePolicy` API. It is bounded
 * executable evidence, not a mechanized theorem.
 */

import { readFile } from "node:fs/promises";

import { planTimePolicy } from "../../../dist/time-policy/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "CORR-021",
  "nested time-policy planner preserves recursive composition bounds",
  "generated nested policies match the recursive model for upper bounds, attempts, parallel work, truncation limits, and typed timeout/deadline warnings",
  async () => {
    const spec = JSON.parse(await readFile(new URL("evidence/nested-time-policy-composition.json", root), "utf8"));
    const policies = generateNestedPolicies(spec.bounds);
    const reports = policies.map((policy) => checkPolicy(policy));
    const reviewReports = spec.reviewCases.map(checkReviewCase);
    const violations = reports.filter((report) => !report.ok);
    const reviewViolations = reviewReports.filter((report) => !report.ok);
    const maxTreeDepth = maxPolicyDepth(policies);
    const timeoutReports = reports.filter((report) => report.policy.type === "timeout");
    const deadlineReports = reports.filter((report) => report.policy.type === "deadline");

    return {
      ok: spec.author === "Admilson B. F. Cossa"
        && spec.spdxLicense === "Apache-2.0"
        && spec.publicApi === "@workit/core/time-policy"
        && spec.planner === "planTimePolicy"
        && spec.compositionRules.length === 6
        && spec.invariants.includes("nested_planner_upper_bound_matches_recursive_model")
        && spec.invariants.includes("nested_retry_or_hedge_truncation_reports_typed_warning")
        && spec.invariants.includes("named_review_cases_match_expected_public_plan")
        && spec.reviewCases.length >= 4
        && policies.length > 0
        && policies.length <= spec.bounds.maxGeneratedPolicies
        && maxTreeDepth <= spec.bounds.maxTreeDepth
        && timeoutReports.some((report) => report.warningCodes.includes("retry_exceeds_timeout"))
        && timeoutReports.some((report) => report.warningCodes.includes("hedge_exceeds_timeout"))
        && deadlineReports.some((report) => report.warningCodes.includes("deadline_infeasible"))
        && spec.limitations.every(hasExplicitLimitation)
        && violations.length === 0
        && reviewViolations.length === 0,
      generatedPolicies: policies.length,
      reviewCases: reviewReports.length,
      maxTreeDepth,
      timeoutCases: timeoutReports.length,
      deadlineCases: deadlineReports.length,
      violations,
      reviewViolations,
      limitations: spec.limitations,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

function generateNestedPolicies(bounds) {
  const policies = [];
  const seen = new Set();
  const leaves = bounds.durationsMs.map((duration) => ({ type: "attempt", duration }));
  let frontier = leaves;

  for (const policy of leaves) addPolicy(policies, seen, bounds.maxGeneratedPolicies, policy);

  for (let depth = 1; depth <= bounds.maxCompositionRounds; depth++) {
    const selected = selectFrontier(frontier, depth);
    const next = [];

    for (let index = 0; index < selected.length; index++) {
      const left = selected[index];
      const right = selected[(index + depth) % selected.length] ?? selected[0];
      next.push({ type: "series", policies: [left, right] });
      next.push({ type: "parallel", policies: [left, right] });
    }

    for (const child of selected) {
      for (const times of bounds.retryTimes) {
        for (const delay of bounds.delaysMs) {
          next.push({
            type: "retry",
            attempt: child,
            retry: { times, initialDelay: delay, backoff: "fixed", jitter: false },
          });
        }
      }

      for (const max of bounds.hedgeMax) {
        for (const after of bounds.delaysMs) {
          next.push({ type: "hedge", attempt: child, after, max });
        }
      }

      for (const limit of bounds.limitsMs) {
        next.push({ type: "timeout", timeout: limit, policy: child });
        next.push({ type: "deadline", now: 0, deadlineAt: limit, policy: child });
      }
    }

    for (const policy of next) addPolicy(policies, seen, bounds.maxGeneratedPolicies, policy);
    frontier = next;
  }

  return policies;
}

function selectFrontier(frontier, depth) {
  const selected = [];
  const stride = Math.max(1, Math.floor(frontier.length / 12));
  for (let index = depth % stride; index < frontier.length && selected.length < 16; index += stride) {
    selected.push(frontier[index]);
  }
  return selected.length > 0 ? selected : frontier.slice(0, 16);
}

function addPolicy(policies, seen, maxGeneratedPolicies, policy) {
  if (policies.length >= maxGeneratedPolicies) return;
  const key = JSON.stringify(policy);
  if (seen.has(key)) return;
  seen.add(key);
  policies.push(policy);
}

function checkPolicy(policy) {
  const modeled = modelCost(policy);
  const planned = planTimePolicy(policy);
  const warningCodes = planned.warnings.map((warning) => warning.code);
  const failures = [];

  if (planned.upperBoundMs !== modeled.upperBoundMs) failures.push("upper_bound_mismatch");
  if (planned.criticalPathMs !== modeled.criticalPathMs) failures.push("critical_path_mismatch");
  if (planned.parallelWorkMs !== modeled.parallelWorkMs) failures.push("parallel_work_mismatch");
  if (planned.attempts !== modeled.attempts) failures.push("attempt_count_mismatch");
  if (planned.valid !== modeled.valid) failures.push("validity_mismatch");

  for (const modeledWarning of modeled.warnings) {
    if (!warningCodes.includes(modeledWarning.code)) failures.push(`missing_warning:${modeledWarning.code}`);
  }

  return {
    ok: failures.length === 0,
    policy,
    modeled,
    planned,
    warningCodes,
    failures,
  };
}

function checkReviewCase(reviewCase) {
  const planned = planTimePolicy(reviewCase.policy);
  const warningCodes = planned.warnings.map((warning) => warning.code);
  const expected = reviewCase.expected;
  const failures = [];

  if (planned.valid !== expected.valid) failures.push("valid");
  if (planned.upperBoundMs !== expected.upperBoundMs) failures.push("upperBoundMs");
  if (planned.criticalPathMs !== expected.criticalPathMs) failures.push("criticalPathMs");
  if (planned.parallelWorkMs !== expected.parallelWorkMs) failures.push("parallelWorkMs");
  if (planned.attempts !== expected.attempts) failures.push("attempts");
  for (const warning of expected.warnings) {
    if (!warningCodes.includes(warning)) failures.push(`warning:${warning}`);
  }

  return {
    ok: failures.length === 0,
    name: reviewCase.name,
    planned,
    expected,
    warningCodes,
    failures,
  };
}

function modelCost(policy) {
  switch (policy.type) {
    case "attempt":
      return modelLeaf(policy.duration);
    case "series":
      return modelSeries(policy.policies);
    case "parallel":
      return modelParallel(policy.policies);
    case "retry":
      return modelRetry(policy);
    case "hedge":
      return modelHedge(policy);
    case "timeout":
      return modelTimeout(policy);
    case "deadline":
      return modelDeadline(policy);
  }
}

function modelLeaf(durationMs) {
  return {
    valid: true,
    upperBoundMs: durationMs,
    criticalPathMs: durationMs,
    parallelWorkMs: durationMs,
    attempts: 1,
    warnings: [],
  };
}

function modelSeries(policies) {
  if (policies.length === 0) return modelEmpty();
  const children = policies.map(modelCost);
  return {
    valid: children.every((child) => child.valid),
    upperBoundMs: sum(children, "upperBoundMs"),
    criticalPathMs: sum(children, "criticalPathMs"),
    parallelWorkMs: sum(children, "parallelWorkMs"),
    attempts: sum(children, "attempts"),
    warnings: children.flatMap((child) => child.warnings),
  };
}

function modelParallel(policies) {
  if (policies.length === 0) return modelEmpty();
  const children = policies.map(modelCost);
  return {
    valid: children.every((child) => child.valid),
    upperBoundMs: Math.max(...children.map((child) => child.upperBoundMs)),
    criticalPathMs: Math.max(...children.map((child) => child.criticalPathMs)),
    parallelWorkMs: sum(children, "parallelWorkMs"),
    attempts: sum(children, "attempts"),
    warnings: children.flatMap((child) => child.warnings),
  };
}

function modelRetry(policy) {
  const attempt = modelCost(policy.attempt);
  const times = policy.retry.times;
  const delay = policy.retry.initialDelay * Math.max(0, times - 1);
  const upperBoundMs = attempt.upperBoundMs * times + delay;

  return {
    valid: attempt.valid,
    upperBoundMs,
    criticalPathMs: upperBoundMs,
    parallelWorkMs: attempt.parallelWorkMs * times,
    attempts: attempt.attempts * times,
    warnings: attempt.warnings,
  };
}

function modelHedge(policy) {
  const attempt = modelCost(policy.attempt);
  const upperBoundMs = attempt.upperBoundMs + policy.after * Math.max(0, policy.max - 1);

  return {
    valid: attempt.valid,
    upperBoundMs,
    criticalPathMs: upperBoundMs,
    parallelWorkMs: attempt.parallelWorkMs * policy.max,
    attempts: attempt.attempts * policy.max,
    warnings: attempt.warnings,
  };
}

function modelTimeout(policy) {
  const inner = modelCost(policy.policy);
  if (inner.upperBoundMs <= policy.timeout) return inner;

  return {
    ...inner,
    upperBoundMs: policy.timeout,
    criticalPathMs: Math.min(inner.criticalPathMs, policy.timeout),
    warnings: [
      ...inner.warnings,
      {
        code: timeoutWarningCode(policy.policy),
        estimatedMs: inner.upperBoundMs,
        limitMs: policy.timeout,
      },
    ],
  };
}

function modelDeadline(policy) {
  const inner = modelCost(policy.policy);
  const remainingMs = Math.max(0, policy.deadlineAt - policy.now);
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
        estimatedMs: inner.upperBoundMs,
        limitMs: remainingMs,
      },
    ],
  };
}

function modelEmpty() {
  return {
    valid: true,
    upperBoundMs: 0,
    criticalPathMs: 0,
    parallelWorkMs: 0,
    attempts: 0,
    warnings: [{ code: "empty_composition" }],
  };
}

function timeoutWarningCode(policy) {
  const types = collectPolicyTypes(policy);
  if (types.has("retry")) return "retry_exceeds_timeout";
  if (types.has("hedge")) return "hedge_exceeds_timeout";
  return "time_exceeds_timeout";
}

function collectPolicyTypes(policy, types = new Set()) {
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

function maxPolicyDepth(policies) {
  return Math.max(...policies.map((policy) => policyDepth(policy)));
}

function policyDepth(policy) {
  switch (policy.type) {
    case "attempt":
      return 1;
    case "series":
    case "parallel":
      return 1 + Math.max(0, ...policy.policies.map(policyDepth));
    case "retry":
    case "hedge":
      return 1 + policyDepth(policy.attempt);
    case "timeout":
    case "deadline":
      return 1 + policyDepth(policy.policy);
  }
}

function sum(items, field) {
  return items.reduce((total, item) => total + item[field], 0);
}

function hasExplicitLimitation(text) {
  return typeof text === "string"
    && text.length > 40
    && (
      text.includes("not ")
      || text.includes("does not")
      || text.includes("without")
      || text.includes("outside")
    );
}
