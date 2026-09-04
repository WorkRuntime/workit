/**
 * Pure decision policy shared by browser preview and real WorkIt execution.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export const INCIDENT_DECISION = Object.freeze({
  ACCEPTED: "accepted",
  QUALITY_REJECTED: "quality_rejected",
  RETRY: "retry_same_candidate",
  NEXT: "try_next_candidate",
  TERMINAL: "terminal",
  REQUIRE_INPUT: "requires_user_input",
});

export const INCIDENT_REASON = Object.freeze({
  APPROVAL_REQUIRED: "production_change_requires_approval",
  EVIDENCE_MISSING: "incident_evidence_missing",
  CONFIDENCE_LOW: "incident_confidence_too_low",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  INVALID_REQUEST: "provider_request_invalid",
  TRANSIENT_PROVIDER: "transient_provider_failure",
  RETRY_BUDGET_EXHAUSTED: "workit_budget_exhausted",
  DEADLINE_EXCEEDED: "workit_timeout",
});

const FAILURE_DECISION = new Map([
  ["transient", Object.freeze({
    disposition: INCIDENT_DECISION.RETRY,
    reasonCode: INCIDENT_REASON.TRANSIENT_PROVIDER,
  })],
  ["unavailable", Object.freeze({
    disposition: INCIDENT_DECISION.NEXT,
    reasonCode: INCIDENT_REASON.PROVIDER_UNAVAILABLE,
  })],
  ["invalid_request", Object.freeze({
    disposition: INCIDENT_DECISION.TERMINAL,
    reasonCode: INCIDENT_REASON.INVALID_REQUEST,
  })],
]);

/** Decide whether one successful recommendation is semantically admissible. */
export function assessRecommendation(value, policy) {
  if (value.risk === "production_write") {
    return Object.freeze({
      disposition: INCIDENT_DECISION.REQUIRE_INPUT,
      reasonCode: INCIDENT_REASON.APPROVAL_REQUIRED,
    });
  }
  if (value.evidence.length < policy.minEvidenceReferences) {
    return Object.freeze({
      disposition: INCIDENT_DECISION.QUALITY_REJECTED,
      reasonCode: INCIDENT_REASON.EVIDENCE_MISSING,
    });
  }
  if (value.confidence < policy.minConfidence) {
    return Object.freeze({
      disposition: INCIDENT_DECISION.QUALITY_REJECTED,
      reasonCode: INCIDENT_REASON.CONFIDENCE_LOW,
    });
  }
  return Object.freeze({ disposition: INCIDENT_DECISION.ACCEPTED });
}

/** Classify one typed provider failure without inspecting free-form messages. */
export function classifyProviderFailure(failureClass) {
  return FAILURE_DECISION.get(failureClass);
}
