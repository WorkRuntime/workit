/**
 * Computes evidence-ledger status without performing file-system I/O.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export const CLAIM_STATUSES = Object.freeze([
  "deferred",
  "environment-blocked",
  "product-decision",
  "proven",
  "unproven",
]);

export const RELEASE_READINESS = Object.freeze({
  BLOCKED: "blocked",
  READY: "ready",
});

const RESOLVED_RELEASE_STATUSES = new Set(["proven"]);

/** Returns deterministic status counts and unresolved release blockers. */
export function summarizeEvidenceLedger(claims) {
  const statusCounts = Object.fromEntries(CLAIM_STATUSES.map((status) => [status, 0]));
  for (const claim of claims) {
    if (!Object.hasOwn(statusCounts, claim.status)) {
      throw new TypeError(`${claim.id} has invalid status`);
    }
    if (claim.releaseBlocking !== undefined && typeof claim.releaseBlocking !== "boolean") {
      throw new TypeError(`${claim.id} has invalid releaseBlocking`);
    }
    statusCounts[claim.status] += 1;
  }

  const releaseBlockers = claims
    .filter((claim) => claim.releaseBlocking === true && !RESOLVED_RELEASE_STATUSES.has(claim.status))
    .map(({ id, status, title }) => ({ id, status, title }));

  return {
    statusCounts,
    releaseReadiness: releaseBlockers.length === 0
      ? RELEASE_READINESS.READY
      : RELEASE_READINESS.BLOCKED,
    releaseBlockers,
  };
}
