/**
 * Release evidence for the 1.0.0 external-consumer packed-artifact canary.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { createSuite } from "../harness.mjs";

const EXPECTED_WORKIT_COMMIT = "64e7199633353aed3cb93e6083c7e3108d1ceac7";
const EXPECTED_TARBALL_SHA256 = "c97f40318a7649d8a6c1fc428ca47ebe3bedc09606a7bea32147e08e09e28a0c";
const FORBIDDEN_PUBLIC_FIELDS = Object.freeze([
  '"providerhint"',
  '"modelid"',
  '"daemonaddress"',
  '"canaryrunid"',
  '"receiptid"',
]);

const suite = createSuite("release");

await suite.proof(
  "REL-015",
  "external-consumer packed-artifact canary gates the 1.0.0 publication",
  "the exact packed 1.0.0 artifact crosses a real provider boundary and durable receipt store without publishing consumer details",
  async () => {
    const receipt = JSON.parse(await readFile(
      new URL("../../../evidence/external-consumer-canary.v1.0.0.json", import.meta.url),
      "utf8",
    ));
    const live = receipt.liveProviderBoundary;
    const replay = receipt.durableReplay;
    const controlled = receipt.controlledBoundaryScenarios;
    const decisions = live?.decisions ?? [];
    const assertions = Object.values(receipt.assertions ?? {});
    const serialized = JSON.stringify(receipt).toLowerCase();

    return {
      ok: receipt.artifact === "workit-external-consumer-canary"
        && receipt.schemaVersion === 1
        && receipt.release === "1.0.0"
        && receipt.source?.workitCommit === EXPECTED_WORKIT_COMMIT
        && receipt.source?.workitTarball?.sha256 === EXPECTED_TARBALL_SHA256
        && [
          receipt.source?.externalHarnessSha256,
          receipt.source?.externalManifestSha256,
          receipt.source?.externalLockfileSha256,
        ].every((digest) => /^[0-9a-f]{64}$/u.test(digest ?? ""))
        && receipt.environment?.externalConsumer === true
        && receipt.environment?.syntheticProvider === false
        && receipt.environment?.durableReceiptStore === true
        && receipt.environment?.credentialMaterialRecorded === false
        && live?.providerCalls === 2
        && live?.candidateStrategies === 2
        && live?.acceptedCandidateIndex === 1
        && live?.sameProviderBoundary === true
        && decisions.some(({ decision }) => decision === "quality_rejected")
        && decisions.some(({ decision }) => decision === "accepted")
        && decisions.every(({ metadataRedacted }) => metadataRedacted === true)
        && decisions.length <= live?.evidenceLimit
        && live?.droppedEvidence === 0
        && replay?.recreatedRuntime === true
        && replay?.replayOperationCalls === 0
        && replay?.providerCallsAfterLiveExecution === replay?.providerCallsAfterReplay
        && replay?.receiptRoundTrip === true
        && replay?.receiptIdentityStable === true
        && controlled?.sharedRetryBudget?.spent === controlled?.sharedRetryBudget?.limit
        && controlled?.sharedRetryBudget?.attempts === 2
        && controlled?.aggregateDeadline?.reasonCode === "workit_timeout"
        && controlled?.requiresUserInput?.fallbackStopped === true
        && controlled?.requiresUserInput?.candidateCalls === 1
        && assertions.length > 0
        && assertions.every(Boolean)
        && receipt.unexpectedProcessFailures?.length === 0
        && FORBIDDEN_PUBLIC_FIELDS.every((field) => !serialized.includes(field)),
      workitVersion: receipt.release,
      workitCommit: receipt.source?.workitCommit,
      tarballSha256: receipt.source?.workitTarball?.sha256,
      providerCalls: live?.providerCalls,
      candidateStrategies: live?.candidateStrategies,
      sameProviderBoundary: live?.sameProviderBoundary,
      decisions: decisions.map(({ candidateIndex, decision, reasonCode }) => ({
        candidateIndex,
        decision,
        reasonCode,
      })),
      replayOperationCalls: replay?.replayOperationCalls,
      sharedRetryBudget: controlled?.sharedRetryBudget,
      aggregateDeadline: controlled?.aggregateDeadline,
      requiresUserInput: controlled?.requiresUserInput,
      limitations: receipt.limitations,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
