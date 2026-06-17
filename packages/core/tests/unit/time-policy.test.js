/**
 * Time policy planner subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { estimateHedge, estimateRetry, planTimePolicy } from "../../dist/time-policy/index.js";

test("Given fixed retry policy, estimateRetry computes runtime-aligned worst-case delay", () => {
  const plan = estimateRetry({
    attempt: { type: "attempt", duration: 100 },
    retry: { times: 3, initialDelay: 50, backoff: "fixed", jitter: false },
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.upperBoundMs, 400);
  assert.equal(plan.attempts, 3);
  assert.deepEqual(plan.warnings, []);
});

test("Given retry under timeout, planTimePolicy reports timeout truncation before execution", () => {
  const plan = planTimePolicy({
    type: "timeout",
    timeout: 250,
    policy: {
      type: "retry",
      attempt: { type: "attempt", duration: 100 },
      retry: { times: 4, initialDelay: 50, backoff: "fixed", jitter: false },
    },
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.upperBoundMs, 250);
  assert.equal(plan.warnings.some((warning) => warning.code === "retry_exceeds_timeout"), true);
});

test("Given hedge policy, estimateHedge includes staggered attempt cost", () => {
  const plan = estimateHedge({
    attempt: { type: "attempt", duration: 100 },
    after: 25,
    max: 3,
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.upperBoundMs, 150);
  assert.equal(plan.attempts, 3);
  assert.equal(plan.parallelWorkMs, 300);
});

test("Given impossible deadline, planTimePolicy returns invalid plan before execution", () => {
  const plan = planTimePolicy({
    type: "deadline",
    now: 1_000,
    deadlineAt: 1_050,
    policy: { type: "attempt", duration: 100 },
  });

  assert.equal(plan.valid, false);
  assert.equal(plan.upperBoundMs, 50);
  assert.equal(plan.warnings.some((warning) => warning.code === "deadline_infeasible"), true);
});

test("Given series and parallel policies, planTimePolicy composes critical path and work", () => {
  const series = planTimePolicy({
    type: "series",
    policies: [
      { type: "attempt", duration: 10 },
      { type: "attempt", duration: 20 },
    ],
  });
  const parallel = planTimePolicy({
    type: "parallel",
    policies: [
      { type: "attempt", duration: 10 },
      { type: "attempt", duration: 20 },
    ],
  });

  assert.equal(series.upperBoundMs, 30);
  assert.equal(series.parallelWorkMs, 30);
  assert.equal(parallel.upperBoundMs, 20);
  assert.equal(parallel.parallelWorkMs, 30);
});

test("Given empty compositions, planTimePolicy returns explicit zero-cost warning", () => {
  const series = planTimePolicy({ type: "series", policies: [] });
  const parallel = planTimePolicy({ type: "parallel", policies: [] });

  assert.equal(series.upperBoundMs, 0);
  assert.equal(parallel.upperBoundMs, 0);
  assert.equal(series.warnings[0].code, "empty_composition");
  assert.equal(parallel.warnings[0].code, "empty_composition");
});

test("Given dynamic backoff and jitter, estimateRetry uses conservative upper-bound warnings", () => {
  const plan = estimateRetry({
    attempt: { type: "attempt", duration: 10 },
    retry: {
      times: 3,
      initialDelay: 5,
      maxDelay: 20,
      backoff: () => 1,
      jitter: true,
    },
  });

  assert.equal(plan.upperBoundMs, 70);
  assert.equal(plan.warnings.some((warning) => warning.code === "dynamic_backoff_upper_bound"), true);
  assert.equal(plan.warnings.some((warning) => warning.code === "jitter_upper_bound"), true);
});

test("Given linear and exponential retry policies, estimateRetry respects maxDelay", () => {
  const linear = estimateRetry({
    attempt: { type: "attempt", duration: 10 },
    retry: { times: 3, initialDelay: 10, maxDelay: 15, backoff: "linear", jitter: false },
  });
  const exponential = estimateRetry({
    attempt: { type: "attempt", duration: 10 },
    retry: { times: 3, initialDelay: 10, maxDelay: 15, backoff: "exponential", jitter: false },
  });

  assert.equal(linear.upperBoundMs, 55);
  assert.equal(exponential.upperBoundMs, 55);
});

test("Given timeout policies, planTimePolicy distinguishes retry, hedge, and generic truncation", () => {
  const retry = planTimePolicy({
    type: "timeout",
    timeout: 10,
    policy: { type: "retry", attempt: { type: "attempt", duration: 20 }, retry: 2 },
  });
  const hedge = planTimePolicy({
    type: "timeout",
    timeout: 10,
    policy: { type: "hedge", attempt: { type: "attempt", duration: 20 }, after: 1, max: 2 },
  });
  const generic = planTimePolicy({
    type: "timeout",
    timeout: 10,
    policy: { type: "attempt", duration: 20 },
  });

  assert.equal(retry.warnings.at(-1).code, "retry_exceeds_timeout");
  assert.equal(hedge.warnings.at(-1).code, "hedge_exceeds_timeout");
  assert.equal(generic.warnings.at(-1).code, "time_exceeds_timeout");
});

test("Given nested timeout policies, planTimePolicy finds retry and hedge inside composition wrappers", () => {
  const seriesRetry = planTimePolicy({
    type: "timeout",
    timeout: 10,
    policy: {
      type: "series",
      policies: [
        { type: "retry", attempt: { type: "attempt", duration: 20 }, retry: 2 },
      ],
    },
  });
  const nestedHedge = planTimePolicy({
    type: "timeout",
    timeout: 10,
    policy: {
      type: "timeout",
      timeout: 1_000,
      policy: { type: "hedge", attempt: { type: "attempt", duration: 20 }, after: 1, max: 2 },
    },
  });

  assert.equal(seriesRetry.warnings.at(-1).code, "retry_exceeds_timeout");
  assert.equal(nestedHedge.warnings.at(-1).code, "hedge_exceeds_timeout");
});

test("Given nested parallel and deadline wrappers, planTimePolicy classifies timeout warnings through the policy tree", () => {
  const parallelRetry = planTimePolicy({
    type: "timeout",
    timeout: 10,
    policy: {
      type: "parallel",
      policies: [
        { type: "retry", attempt: { type: "attempt", duration: 20 }, retry: 2 },
      ],
    },
  });
  const deadlineHedge = planTimePolicy({
    type: "timeout",
    timeout: 10,
    policy: {
      type: "deadline",
      now: 1_000,
      deadlineAt: 2_000,
      policy: { type: "hedge", attempt: { type: "attempt", duration: 20 }, after: 1, max: 2 },
    },
  });

  assert.equal(parallelRetry.warnings.at(-1).code, "retry_exceeds_timeout");
  assert.equal(deadlineHedge.warnings.at(-1).code, "hedge_exceeds_timeout");
});

test("Given feasible timeout and deadline policies, planTimePolicy returns the inner plan unchanged", () => {
  const timeout = planTimePolicy({
    type: "timeout",
    timeout: 100,
    policy: { type: "attempt", duration: 20 },
  });
  const deadline = planTimePolicy({
    type: "deadline",
    now: 1_000,
    deadlineAt: new Date(1_100),
    policy: { type: "attempt", duration: 20 },
  });

  assert.equal(timeout.upperBoundMs, 20);
  assert.equal(deadline.upperBoundMs, 20);
  assert.deepEqual(timeout.warnings, []);
  assert.deepEqual(deadline.warnings, []);
});

test("Given deadline without explicit now, planTimePolicy uses the current clock", () => {
  const plan = planTimePolicy({
    type: "deadline",
    deadlineAt: Date.now() + 1_000,
    policy: { type: "attempt", duration: 1 },
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.upperBoundMs, 1);
});

test("Given invalid hedge and excessive nesting, planner rejects invalid contracts", () => {
  assert.throws(
    () => estimateHedge({ attempt: { type: "attempt", duration: 1 }, after: 1, max: 0 }),
    /hedge max/,
  );

  let nested = { type: "attempt", duration: 1 };
  for (let index = 0; index < 66; index++) {
    nested = { type: "timeout", timeout: 10_000, policy: nested };
  }

  assert.throws(() => planTimePolicy(nested), /time policy depth exceeded/);

  let nestedRetry = { type: "attempt", duration: 1 };
  let nestedHedge = { type: "attempt", duration: 1 };
  for (let index = 0; index < 66; index++) {
    nestedRetry = { type: "retry", attempt: nestedRetry, retry: 1 };
    nestedHedge = { type: "hedge", attempt: nestedHedge, after: 1, max: 1 };
  }

  assert.throws(() => planTimePolicy(nestedRetry), /time policy depth exceeded/);
  assert.throws(() => planTimePolicy(nestedHedge), /time policy depth exceeded/);
});

test("Given the root import, time-policy helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("planTimePolicy" in root, false);
  assert.equal("estimateRetry" in root, false);
  assert.equal("estimateHedge" in root, false);
});
