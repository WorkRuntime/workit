/**
 * Real WorkIt executor for one validated incident-policy scenario.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createBudget, run } from "@workit/core";
import { firstAcceptable } from "@workit/core/candidates";
import { validateScenario } from "../contract/scenario-contract.mjs";
import {
  assessRecommendation,
  classifyProviderFailure,
  INCIDENT_DECISION,
  INCIDENT_REASON,
} from "../policy/incident-policy.mjs";

const RETRY_BUDGET_UNIT = "retries";
const IncidentRetryBudget = createBudget("FailureLabIncidentRetryBudget", {
  unit: RETRY_BUDGET_UNIT,
});

class ScenarioProviderError extends Error {
  constructor(failureClass) {
    super(`provider failure: ${failureClass}`);
    this.name = "ScenarioProviderError";
    this.failureClass = failureClass;
  }
}

class ApprovalRequiredError extends Error {
  constructor(action) {
    super(`operator approval required for ${action}`);
    this.name = "ApprovalRequiredError";
  }
}

const ERROR_CLASSIFIERS = Object.freeze([
  Object.freeze({
    matches: (error) => error instanceof ApprovalRequiredError,
    decide: () => Object.freeze({
      disposition: INCIDENT_DECISION.REQUIRE_INPUT,
      reasonCode: INCIDENT_REASON.APPROVAL_REQUIRED,
    }),
  }),
  Object.freeze({
    matches: (error) => error instanceof ScenarioProviderError,
    decide: (error) => classifyProviderFailure(error.failureClass),
  }),
]);

const UNAVAILABLE_DECISION = Object.freeze({
  disposition: INCIDENT_DECISION.NEXT,
  reasonCode: INCIDENT_REASON.PROVIDER_UNAVAILABLE,
});

/** Execute a validated scenario through the published WorkIt candidate runtime. */
export async function runScenarioWithWorkIt(input) {
  const scenario = validateScenario(input);
  const startedAt = Date.now();
  const retryBudget = {
    spent: 0,
    limit: scenario.policy.retryLimit,
    unit: RETRY_BUDGET_UNIT,
  };

  const execution = await run.context.with(IncidentRetryBudget, retryBudget, async () => {
    const outcome = await firstAcceptable(scenario.candidates, {
      execute: executeCandidate(scenario.policy),
      accept: (value) => acceptanceDecision(value, scenario.policy),
      classifyFailure: classifyFailure,
      retry: {
        times: scenario.policy.retryLimit + 1,
        initialDelay: 0,
        jitter: false,
        retryBudget: IncidentRetryBudget,
      },
      deadlineAt: startedAt + scenario.policy.deadlineMs,
      evidence: { maxAttempts: scenario.policy.maxEvidenceAttempts },
      candidateMetadata: ({ id, name }) => ({ id, name }),
    });
    return {
      outcome,
      retryBudget: run.context.budget(IncidentRetryBudget),
    };
  });

  return normalizeResult(scenario, execution, Date.now() - startedAt);
}

function executeCandidate(policy) {
  return async (candidate, ctx) => {
    await sleep(candidate.latencyMs, ctx.signal);
    const outcome = candidate.outcomes[Math.min(ctx.attempt - 1, candidate.outcomes.length - 1)];
    if (outcome.type === "failure") throw new ScenarioProviderError(outcome.failureClass);
    const decision = assessRecommendation(outcome, policy);
    if (decision.disposition === INCIDENT_DECISION.REQUIRE_INPUT) {
      throw new ApprovalRequiredError(outcome.action);
    }
    return outcome;
  };
}

function acceptanceDecision(value, policy) {
  const decision = assessRecommendation(value, policy);
  return decision.disposition === INCIDENT_DECISION.ACCEPTED
    ? { accepted: true }
    : { accepted: false, reasonCode: decision.reasonCode };
}

function classifyFailure(error) {
  return ERROR_CLASSIFIERS.find(({ matches }) => matches(error))?.decide(error)
    ?? UNAVAILABLE_DECISION;
}

function normalizeResult(scenario, execution, durationMs) {
  const outcome = execution.outcome;
  return Object.freeze({
    execution: "workit_runtime",
    package: "@workit/core",
    scenarioId: scenario.id,
    status: outcome.status,
    ...(outcome.status === "accepted" ? {
      candidateId: outcome.candidate.id,
      action: outcome.value.action,
    } : {}),
    ...("reasonCode" in outcome ? { reasonCode: outcome.reasonCode } : {}),
    durationMs,
    retryBudget: execution.retryBudget,
    evidence: outcome.evidence.map((attempt) => ({
      candidateId: scenario.candidates[attempt.candidateIndex]?.id ?? "unknown",
      attempt: attempt.attempt,
      decision: attempt.decision,
      ...(attempt.reasonCode === undefined ? {} : { reasonCode: attempt.reasonCode }),
      durationMs: attempt.durationMs,
    })),
    droppedEvidence: outcome.droppedEvidence,
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
