/**
 * Auditable AI incident-decision gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Selects a grounded incident recommendation, contains transient retries inside
 * one end-to-end deadline, and stops before a production change that requires
 * operator authority. The providers are deterministic local fixtures so the
 * policy contract runs without credentials or network access.
 */

import assert from "node:assert/strict";
import { createBudget, run } from "@workit/core";
import { firstAcceptable } from "@workit/core/candidates";

const DISPOSITION = Object.freeze({
  RETRY: "retry_same_candidate",
  NEXT: "try_next_candidate",
  REQUIRE_INPUT: "requires_user_input",
});
const REASON = Object.freeze({
  TRANSIENT_PROVIDER: "transient_provider_failure",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  APPROVAL_REQUIRED: "production_change_requires_approval",
  EVIDENCE_MISSING: "incident_evidence_missing",
  CONFIDENCE_LOW: "incident_confidence_too_low",
});
const RISK = Object.freeze({
  READ_ONLY: "read_only",
  PRODUCTION_WRITE: "production_write",
});
const ACTION = Object.freeze({
  COLLECT_DIAGNOSTICS: "collect_diagnostics",
  ROLLBACK: "rollback_deployment",
});
const MIN_CONFIDENCE = 0.85;
const MIN_EVIDENCE_REFERENCES = 2;
const END_TO_END_BUDGET_MS = 2_000;
const RETRY_LIMIT = 1;
const MAX_RETAINED_ATTEMPTS = 4;
const RETRY_BUDGET_UNIT = "retries";
const RetryBudget = createBudget("IncidentDecisionRetryBudget", { unit: RETRY_BUDGET_UNIT });

class TransientProviderError extends Error {}
class ApprovalRequiredError extends Error {}

const FAILURE_POLICY = new Map([
  [TransientProviderError, Object.freeze({
    disposition: DISPOSITION.RETRY,
    reasonCode: REASON.TRANSIENT_PROVIDER,
  })],
  [ApprovalRequiredError, Object.freeze({
    disposition: DISPOSITION.REQUIRE_INPUT,
    reasonCode: REASON.APPROVAL_REQUIRED,
  })],
]);
const DEFAULT_FAILURE_POLICY = Object.freeze({
  disposition: DISPOSITION.NEXT,
  reasonCode: REASON.PROVIDER_UNAVAILABLE,
});

const selectionCalls = [];
const selectionCandidates = [
  candidate("fast-triage", "https://triage.internal", async (ctx) => {
    selectionCalls.push(`fast-triage:${ctx.attempt}`);
    return recommendation(ACTION.COLLECT_DIAGNOSTICS, RISK.READ_ONLY, 0.97, []);
  }),
  candidate("grounded-reasoner", "https://reasoner.internal", async (ctx) => {
    selectionCalls.push(`grounded-reasoner:${ctx.attempt}`);
    if (ctx.attempt === 1) throw new TransientProviderError("provider overloaded");
    return recommendation(ACTION.COLLECT_DIAGNOSTICS, RISK.READ_ONLY, 0.93, [
      "trace:checkout-timeout",
      "metric:payment-error-rate",
    ]);
  }),
  candidate("unbounded-autopilot", "https://autopilot.internal", async (ctx) => {
    selectionCalls.push(`unbounded-autopilot:${ctx.attempt}`);
    return recommendation(ACTION.ROLLBACK, RISK.PRODUCTION_WRITE, 0.99, ["trace:x", "metric:y"]);
  }),
];

const selection = await run.context.with(
  RetryBudget,
  { spent: 0, limit: RETRY_LIMIT, unit: RETRY_BUDGET_UNIT },
  async () => {
    const outcome = await selectIncidentRecommendation(selectionCandidates);
    return { outcome, retryBudget: run.context.budget(RetryBudget) };
  },
);

assert.equal(selection.outcome.status, "accepted");
assert.equal(selection.outcome.candidate.name, "grounded-reasoner");
assert.equal(selection.outcome.value.action, ACTION.COLLECT_DIAGNOSTICS);
assert.deepEqual(selectionCalls, ["fast-triage:1", "grounded-reasoner:1", "grounded-reasoner:2"]);
assert.deepEqual(selection.outcome.evidence.map(({ decision }) => decision), [
  "quality_rejected",
  DISPOSITION.RETRY,
  "accepted",
]);
assert.deepEqual(selection.retryBudget, { spent: 1, limit: 1, unit: RETRY_BUDGET_UNIT });
assert.equal(selection.outcome.droppedEvidence, 0);
assertMetadataIsRedacted(selection.outcome.evidence);

const approvalCalls = [];
let executedProductionChanges = 0;
const approvalCandidates = [
  candidate("rollback-planner", "https://rollback.internal", async (ctx) => {
    approvalCalls.push(`rollback-planner:${ctx.attempt}`);
    return recommendation(ACTION.ROLLBACK, RISK.PRODUCTION_WRITE, 0.96, [
      "deploy:checkout-v42",
      "metric:checkout-error-rate",
    ]);
  }),
  candidate("unsafe-fallback", "https://unsafe.internal", async (ctx) => {
    approvalCalls.push(`unsafe-fallback:${ctx.attempt}`);
    executedProductionChanges++;
    return recommendation(ACTION.ROLLBACK, RISK.PRODUCTION_WRITE, 0.99, ["deploy:x", "metric:y"]);
  }),
];
const approval = await selectIncidentRecommendation(approvalCandidates);

assert.equal(approval.status, "requires_user_input");
assert.equal(approval.reasonCode, REASON.APPROVAL_REQUIRED);
assert.deepEqual(approvalCalls, ["rollback-planner:1"]);
assert.equal(executedProductionChanges, 0);
assert.equal(approval.evidence[0]?.decision, DISPOSITION.REQUIRE_INPUT);
assertMetadataIsRedacted(approval.evidence);

process.stdout.write(`${JSON.stringify({
  sample: "incident-decision-gate",
  selection: {
    status: selection.outcome.status,
    selectedCandidate: selection.outcome.candidate.name,
    action: selection.outcome.value.action,
    decisions: selection.outcome.evidence.map(({ decision }) => decision),
    admittedCalls: selectionCalls,
    retryBudget: selection.retryBudget,
    droppedEvidence: selection.outcome.droppedEvidence,
    credentialsRedacted: evidenceIsRedacted(selection.outcome.evidence),
  },
  approval: {
    status: approval.status,
    reasonCode: approval.reasonCode,
    admittedCalls: approvalCalls,
    productionChangesExecuted: executedProductionChanges,
    credentialsRedacted: evidenceIsRedacted(approval.evidence),
  },
})}\n`);

function selectIncidentRecommendation(candidates) {
  const deadlineAt = Date.now() + END_TO_END_BUDGET_MS;
  return firstAcceptable(candidates, {
    execute: async (provider, ctx) => enforceAuthority(await provider.propose(ctx)),
    accept: assessRecommendation,
    classifyFailure,
    retry: { times: 2, initialDelay: 0, jitter: false, retryBudget: RetryBudget },
    deadlineAt,
    evidence: { maxAttempts: MAX_RETAINED_ATTEMPTS },
    candidateMetadata: ({ name, endpoint, apiKey }) => ({ name, endpoint, apiKey }),
  });
}

function assessRecommendation(value) {
  const failedRule = [
    [value.evidence.length < MIN_EVIDENCE_REFERENCES, REASON.EVIDENCE_MISSING],
    [value.confidence < MIN_CONFIDENCE, REASON.CONFIDENCE_LOW],
  ].find(([failed]) => failed);
  return failedRule === undefined
    ? { accepted: true }
    : { accepted: false, reasonCode: failedRule[1] };
}

function enforceAuthority(value) {
  if (value.risk === RISK.PRODUCTION_WRITE) {
    throw new ApprovalRequiredError("operator approval required before production mutation");
  }
  return value;
}

function classifyFailure(error) {
  const policy = [...FAILURE_POLICY].find(([ErrorType]) => error instanceof ErrorType)?.[1];
  return policy ?? DEFAULT_FAILURE_POLICY;
}

function candidate(name, endpoint, propose) {
  return Object.freeze({ name, endpoint, apiKey: `secret-for-${name}`, propose });
}

function recommendation(action, risk, confidence, evidence) {
  return Object.freeze({ action, risk, confidence, evidence: Object.freeze(evidence) });
}

function assertMetadataIsRedacted(evidence) {
  assert.equal(evidenceIsRedacted(evidence), true);
  assert.equal(JSON.stringify(evidence).includes("secret-for-"), false);
}

function evidenceIsRedacted(evidence) {
  return evidence.every(({ metadata }) => metadata?.apiKey === "[redacted]");
}
