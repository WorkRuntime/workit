/**
 * Correctness evidence: time policy planning without task execution.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

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

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
