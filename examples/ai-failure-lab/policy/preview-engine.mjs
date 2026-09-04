/**
 * Deterministic browser preview for a validated failure scenario.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateScenario } from "../contract/scenario-contract.mjs";
import {
  assessRecommendation,
  classifyProviderFailure,
  INCIDENT_DECISION,
  INCIDENT_REASON,
} from "./incident-policy.mjs";

/** Evaluate a scenario without performing I/O or claiming WorkIt runtime execution. */
export function previewScenario(input) {
  const scenario = validateScenario(input);
  const state = {
    elapsedMs: 0,
    retrySpent: 0,
    evidence: [],
    droppedEvidence: 0,
  };

  for (const candidate of scenario.candidates) {
    const candidateResult = previewCandidate(candidate, scenario.policy, state);
    if (candidateResult !== undefined) return finish(candidateResult, state, scenario.policy);
  }

  return finish({ status: "exhausted" }, state, scenario.policy);
}

function previewCandidate(candidate, policy, state) {
  for (let outcomeIndex = 0; outcomeIndex < candidate.outcomes.length; outcomeIndex++) {
    const attempt = outcomeIndex + 1;
    if (state.elapsedMs + candidate.latencyMs > policy.deadlineMs) {
      state.elapsedMs = policy.deadlineMs;
      retainEvidence(state, policy, {
        candidateId: candidate.id,
        attempt,
        elapsedMs: state.elapsedMs,
        decision: INCIDENT_DECISION.TERMINAL,
        reasonCode: INCIDENT_REASON.DEADLINE_EXCEEDED,
      });
      return { status: "terminal", reasonCode: INCIDENT_REASON.DEADLINE_EXCEEDED };
    }

    state.elapsedMs += candidate.latencyMs;
    const outcome = candidate.outcomes[outcomeIndex];
    const decision = outcome.type === "success"
      ? assessRecommendation(outcome, policy)
      : classifyProviderFailure(outcome.failureClass);
    retainEvidence(state, policy, evidenceFor(candidate.id, attempt, state.elapsedMs, outcome, decision));

    const terminal = terminalResult(decision, candidate, outcome);
    if (terminal !== undefined) return terminal;
    if (decision.disposition === INCIDENT_DECISION.NEXT
      || decision.disposition === INCIDENT_DECISION.QUALITY_REJECTED) return undefined;
    if (decision.disposition === INCIDENT_DECISION.RETRY) {
      if (state.retrySpent >= policy.retryLimit) {
        retainEvidence(state, policy, {
          candidateId: candidate.id,
          attempt,
          elapsedMs: state.elapsedMs,
          decision: INCIDENT_DECISION.TERMINAL,
          reasonCode: INCIDENT_REASON.RETRY_BUDGET_EXHAUSTED,
        });
        return { status: "terminal", reasonCode: INCIDENT_REASON.RETRY_BUDGET_EXHAUSTED };
      }
      state.retrySpent++;
      continue;
    }
  }

  return undefined;
}

function terminalResult(decision, candidate, outcome) {
  if (decision.disposition === INCIDENT_DECISION.ACCEPTED) {
    return {
      status: "accepted",
      candidateId: candidate.id,
      action: outcome.action,
    };
  }
  if (decision.disposition === INCIDENT_DECISION.REQUIRE_INPUT) {
    return {
      status: "requires_user_input",
      candidateId: candidate.id,
      action: outcome.action,
      reasonCode: decision.reasonCode,
    };
  }
  if (decision.disposition === INCIDENT_DECISION.TERMINAL) {
    return { status: "terminal", reasonCode: decision.reasonCode };
  }
  return undefined;
}

function evidenceFor(candidateId, attempt, elapsedMs, outcome, decision) {
  return {
    candidateId,
    attempt,
    elapsedMs,
    decision: decision.disposition,
    ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
    ...(outcome.type === "failure" ? { failureClass: outcome.failureClass } : {
      confidence: outcome.confidence,
      evidenceReferences: outcome.evidence.length,
      action: outcome.action,
      risk: outcome.risk,
    }),
  };
}

function retainEvidence(state, policy, evidence) {
  if (state.evidence.length < policy.maxEvidenceAttempts) {
    state.evidence.push(Object.freeze(evidence));
    return;
  }
  state.droppedEvidence++;
}

function finish(result, state, policy) {
  return Object.freeze({
    ...result,
    elapsedMs: state.elapsedMs,
    retryBudget: Object.freeze({ spent: state.retrySpent, limit: policy.retryLimit }),
    evidence: Object.freeze([...state.evidence]),
    droppedEvidence: state.droppedEvidence,
    execution: "policy_preview",
  });
}
