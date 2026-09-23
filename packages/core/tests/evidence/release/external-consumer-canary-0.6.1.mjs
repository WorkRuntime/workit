/**
 * Release evidence for the 0.6.1 external-consumer canary.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { createSuite } from "../harness.mjs";

const suite = createSuite("release");

await suite.proof(
  "REL-013",
  "external-consumer canary gates the 0.6.1 publication",
  "the packed 0.6.1 artifact crosses real provider and durable-receipt boundaries without publishing consumer details",
  async () => {
    const receipt = JSON.parse(await readFile(
      new URL("../../../evidence/external-consumer-canary.v0.6.1.json", import.meta.url),
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
        && receipt.release === "0.6.1"
        && /^[0-9a-f]{40}$/u.test(receipt.source?.workitCommit ?? "")
        && [
          receipt.source?.workitTarball?.sha256,
          receipt.source?.externalHarnessSha256,
          receipt.source?.externalManifestSha256,
          receipt.source?.externalLockfileSha256,
        ].every((digest) => /^[0-9a-f]{64}$/u.test(digest ?? ""))
        && receipt.environment?.externalConsumer === true
        && receipt.environment?.syntheticProvider === false
        && receipt.environment?.credentialMaterialRecorded === false
        && live?.providerCalls === 2
        && live?.acceptedCandidateIndex === 1
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
        && !serialized.includes("providerhint")
        && !serialized.includes("modelid")
        && !serialized.includes("daemonaddress"),
      workitVersion: receipt.release,
      workitCommit: receipt.source?.workitCommit,
      tarballSha256: receipt.source?.workitTarball?.sha256,
      providerCalls: live?.providerCalls,
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
