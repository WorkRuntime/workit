/**
 * Single manifest of publication evidence proof processes.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

/** Proof processes executed by the publication evidence runner. */
export const evidenceProofs = Object.freeze([
  proof("lifecycle/owned-work.mjs"),
  proof("lifecycle/activity-restart.mjs"),
  proof("lifecycle/resource-audit.mjs"),
  proof("lifecycle/resource-ownership.mjs"),
  proof("lifecycle/replay-receipts.mjs"),
  proof("lifecycle/candidate-lifecycle.mjs"),
  proof("correctness/agent-authority.mjs"),
  proof("correctness/analysis-verifiers.mjs"),
  proof("correctness/activity-boundary.mjs"),
  proof("correctness/candidate-policy.mjs"),
  proof("correctness/candidate-scenarios.mjs"),
  proof("correctness/fault-injection.mjs"),
  proof("correctness/resource-ownership-model.mjs"),
  proof("correctness/runtime-contracts.mjs"),
  proof("correctness/runtime-resilience.mjs"),
  proof("correctness/source-protocol-analysis.mjs"),
  proof("correctness/time-policy-planner.mjs"),
  proof("correctness/formal-time-policy-model.mjs"),
  proof("correctness/nested-time-policy-composition.mjs"),
  proof("correctness/typed-cancellation-contracts.mjs"),
  proof("security/worker-boundary.mjs"),
  proof("security/candidate-boundary.mjs"),
  proof("release/candidate-package-contract.mjs"),
  proof("release/core-release-contracts.mjs"),
  proof("release/hardening-contracts.mjs"),
  proof("release/oryn-candidate-canary.mjs"),
  proof("release/oryn-hardening-canary.mjs"),
  proof("release/release-integrity.mjs"),
  proof("release/receipt-ledger.mjs"),
  proof("release/sql-receipt-ledger.mjs"),
  proof("release/sql-ledger-integration.mjs"),
  proof("performance/benchmark-contracts.mjs"),
  proof("performance/candidate-bounds.mjs", ["--expose-gc"]),
]);

function proof(file, nodeArguments = []) {
  return Object.freeze({ file, nodeArguments: Object.freeze([...nodeArguments]) });
}
