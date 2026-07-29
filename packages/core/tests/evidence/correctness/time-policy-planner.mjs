/**
 * Correctness evidence: time policy planning without task execution.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createBudget } from "../../../dist/index.js";
import { estimateRetry, planTimePolicy } from "../../../dist/time-policy/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-009",
  "time-policy planner computes retry upper bounds",
  "retry upper bound includes attempt duration and delays between failed attempts only",
  async () => {
    const plan = estimateRetry({
      attempt: { type: "attempt", duration: 100 },
      retry: { times: 3, initialDelay: 50, backoff: "fixed", jitter: false },
    });

    return {
      ok: plan.valid && plan.upperBoundMs === 400 && plan.attempts === 3,
      upperBoundMs: plan.upperBoundMs,
      attempts: plan.attempts,
      warnings: plan.warnings.map((warning) => warning.code),
    };
  },
);

await suite.proof(
  "CORR-010",
  "time-policy planner reports infeasible deadline",
  "deadline planning returns invalid before runtime execution when policy cannot fit",
  async () => {
    const plan = planTimePolicy({
      type: "deadline",
      now: 1_000,
      deadlineAt: 1_050,
      policy: { type: "attempt", duration: 100 },
    });

    return {
      ok: !plan.valid
        && plan.upperBoundMs === 50
        && plan.warnings.some((warning) => warning.code === "deadline_infeasible"),
      valid: plan.valid,
      upperBoundMs: plan.upperBoundMs,
      warnings: plan.warnings.map((warning) => warning.code),
    };
  },
);

await suite.proof(
  "CORR-027",
  "time-policy planner aggregates shared retry budget demand",
  "nested retry policies using one budget key are rejected before execution when aggregate retry demand exceeds the supplied runtime snapshot",
  async () => {
    const RetryBudget = createBudget("PlannedSharedRetryBudget", { unit: "retries" });
    const plan = planTimePolicy({
      type: "series",
      policies: [
        {
          type: "retry",
          attempt: { type: "attempt", duration: 10 },
          retry: { times: 2, retryBudget: RetryBudget },
        },
        {
          type: "retry",
          attempt: {
            type: "retry",
            attempt: { type: "attempt", duration: 10 },
            retry: { times: 2, retryBudget: RetryBudget },
          },
          retry: { times: 3, retryBudget: RetryBudget },
        },
      ],
    }, {
      retryBudgets: [{
        key: RetryBudget,
        state: { limit: 6, spent: 1, unit: "retries" },
      }],
    });

    return {
      ok: !plan.valid
        && plan.retryBudgets.length === 1
        && plan.retryBudgets[0]?.key === RetryBudget.name
        && plan.retryBudgets[0]?.required === 6
        && plan.retryBudgets[0]?.remaining === 5
        && plan.retryBudgets[0]?.status === "exceeded"
        && plan.warnings.some((warning) => warning.code === "retry_budget_exceeded"),
      valid: plan.valid,
      retryBudgets: plan.retryBudgets,
      warnings: plan.warnings.map((warning) => warning.code),
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
