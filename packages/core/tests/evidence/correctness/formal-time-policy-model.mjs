/**
 * Correctness evidence: bounded time-policy cost model.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This finite model checks that WorkIt's public time-policy planner does not
 * underestimate modeled policy cost for bounded retry, hedge, timeout,
 * deadline, series, and parallel compositions.
 */

import { readFile } from "node:fs/promises";

import { planTimePolicy } from "../../../dist/time-policy/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "CORR-016",
  "bounded time-policy model preserves cost upper-bound invariant",
  "for generated bounded policies, planTimePolicy returns an upper bound that dominates the modeled critical path cost",
  async () => {
    const spec = JSON.parse(await readFile(new URL("evidence/formal-time-policy-model.json", root), "utf8"));
    const policies = generatePolicies(spec);
    const violations = [];

    for (const policy of policies) {
      const modeled = modelCost(policy);
      const planned = planTimePolicy(policy);
      const violation = checkPlan(policy, modeled, planned);
      if (violation !== null) violations.push(violation);
    }

    return {
      ok: spec.author === "Admilson B. F. Cossa"
        && spec.spdxLicense === "Apache-2.0"
        && spec.model.policyForms.includes("retry")
        && spec.model.policyForms.includes("hedge")
        && spec.model.invariants.includes("planner_upper_bound_dominates_modeled_cost")
        && policies.length > 0
        && policies.length <= spec.bounds.maxGeneratedPolicies
        && violations.length === 0,
      generatedPolicies: policies.length,
      violations,
      limitations: spec.limitations,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

function generatePolicies(spec) {
  const bounds = spec.bounds;
  const policies = [];
  const seen = new Set();
  let previous = bounds.durationsMs.map((duration) => ({ type: "attempt", duration }));

  for (const policy of previous) addPolicy(policies, seen, bounds.maxGeneratedPolicies, policy);

  for (let depth = 1; depth <= bounds.maxDepth; depth++) {
    const selected = previous.slice(0, 8);
    const next = [];

    for (const left of selected) {
      for (const right of selected.slice(0, 4)) {
        next.push({ type: "series", policies: [left, right] });
        next.push({ type: "parallel", policies: [left, right] });
      }
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
    previous = next;
  }

  return policies;
}

function addPolicy(policies, seen, maxGeneratedPolicies, policy) {
  if (policies.length >= maxGeneratedPolicies) return;
  const key = JSON.stringify(policy);
  if (seen.has(key)) return;
  seen.add(key);
  policies.push(policy);
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
    warnings: [...inner.warnings, { code: "deadline_infeasible", limitMs: remainingMs }],
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

function checkPlan(policy, modeled, planned) {
  if (planned.upperBoundMs < modeled.upperBoundMs) {
    return { kind: "underestimated_upper_bound", policy, modeled, planned };
  }
  if (planned.criticalPathMs < modeled.criticalPathMs) {
    return { kind: "underestimated_critical_path", policy, modeled, planned };
  }
  if (planned.parallelWorkMs !== modeled.parallelWorkMs) {
    return { kind: "parallel_work_mismatch", policy, modeled, planned };
  }
  if (planned.attempts !== modeled.attempts) {
    return { kind: "attempt_count_mismatch", policy, modeled, planned };
  }
  if (planned.valid !== modeled.valid) {
    return { kind: "validity_mismatch", policy, modeled, planned };
  }

  const modeledWarnings = new Set(modeled.warnings.map((warning) => warning.code));
  const plannedWarnings = new Set(planned.warnings.map((warning) => warning.code));
  for (const warning of modeledWarnings) {
    if (!plannedWarnings.has(warning)) {
      return { kind: "missing_warning", warning, policy, modeled, planned };
    }
  }

  return null;
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

function sum(items, field) {
  return items.reduce((total, item) => total + item[field], 0);
}
