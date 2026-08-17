/**
 * Evidence-ledger release-readiness policy tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from "vitest";
import {
  CLAIM_STATUSES,
  RELEASE_READINESS,
  summarizeEvidenceLedger,
} from "../../scripts/evidence-ledger-status.mjs";

describe("evidence ledger release readiness", () => {
  test.each(["deferred", "environment-blocked", "product-decision", "unproven"])(
    "treats a release-blocking %s claim as unresolved",
    (status) => {
      const summary = summarizeEvidenceLedger([
        { id: "REL-011", status, title: "real integration canary", releaseBlocking: true },
      ]);

      expect(summary.releaseReadiness).toBe(RELEASE_READINESS.BLOCKED);
      expect(summary.releaseBlockers).toEqual([
        { id: "REL-011", status, title: "real integration canary" },
      ]);
    },
  );

  test("does not let non-blocking or resolved claims prevent a release", () => {
    const claims = [
      { id: "CORR-001", status: "unproven", title: "future research" },
      { id: "REL-001", status: "proven", title: "release proof", releaseBlocking: true },
      {
        id: "PROD-001",
        status: "product-decision",
        title: "declared boundary",
      },
    ];

    const summary = summarizeEvidenceLedger(claims);

    expect(summary.releaseReadiness).toBe(RELEASE_READINESS.READY);
    expect(summary.releaseBlockers).toEqual([]);
    expect(summary.statusCounts).toEqual({
      deferred: 0,
      "environment-blocked": 0,
      "product-decision": 1,
      proven: 1,
      unproven: 1,
    });
    expect(Object.keys(summary.statusCounts)).toEqual(CLAIM_STATUSES);
  });

  test("rejects unknown claim statuses", () => {
    expect(() => summarizeEvidenceLedger([
      { id: "REL-011", status: "passing", title: "invalid state", releaseBlocking: true },
    ])).toThrow("REL-011 has invalid status");
  });

  test("rejects a non-boolean release-blocking marker", () => {
    expect(() => summarizeEvidenceLedger([
      { id: "REL-011", status: "deferred", title: "invalid marker", releaseBlocking: "yes" },
    ])).toThrow("REL-011 has invalid releaseBlocking");
  });
});
