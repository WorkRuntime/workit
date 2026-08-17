/**
 * Release evidence for the Oryn real-provider and durable-replay canary.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { createSuite } from "../harness.mjs";

const suite = createSuite("release");

await suite.proof(
  "REL-011",
  "Oryn real integration canary gates the 0.6.0 publication",
  "the packed 0.6.0 candidate policy crosses Oryn's real provider and daemon boundaries while preserving quality fallback, durable replay, bounded redaction, retry budget, deadline cancellation, and user-input stop",
  async () => {
    const receipt = JSON.parse(await readFile(
      new URL("../../../evidence/oryn-candidate-canary.v0.6.0.json", import.meta.url),
      "utf8",
    ));
    const live = receipt.liveProviderBoundary;
    const replay = receipt.durableReplay;
    const controlled = receipt.controlledBoundaryScenarios;
    const assertions = Object.values(receipt.assertions ?? {});
    const serialized = JSON.stringify(receipt);
    const decisions = live?.decisions ?? [];

    return {
      ok: receipt.artifact === "workit-oryn-candidate-canary"
        && receipt.schemaVersion === 1
        && receipt.release === "0.6.0"
        && /^[0-9a-f]{40}$/u.test(receipt.source?.workitCommit ?? "")
        && /^[0-9a-f]{40}$/u.test(receipt.source?.orynCommit ?? "")
        && /^[0-9a-f]{64}$/u.test(receipt.source?.workitTarball?.sha256 ?? "")
        && /^[0-9a-f]{64}$/u.test(receipt.source?.canaryScriptSha256 ?? "")
        && receipt.environment?.syntheticProvider === false
        && receipt.environment?.daemonEnabled === true
        && receipt.route?.providerHint === "ollama"
        && live?.providerCalls === 2
        && live?.acceptedCandidateIndex === 1
        && decisions.some(({ decision }) => decision === "quality_rejected")
        && decisions.some(({ decision }) => decision === "accepted")
        && decisions.every(({ token }) => token === "[redacted]")
        && live?.droppedEvidence === 0
        && decisions.length <= live?.evidenceLimit
        && replay?.recreatedRuntime === true
        && replay?.replayOperationCalls === 0
        && replay?.providerCallsAfterLiveExecution === replay?.providerCallsAfterReplay
        && replay?.daemonReceiptRoundTrip === true
        && replay?.receiptId === replay?.replayReceiptId
        && controlled?.sharedRetryBudget?.spent === controlled?.sharedRetryBudget?.limit
        && controlled?.sharedRetryBudget?.attempts === 2
        && controlled?.aggregateDeadline?.reasonCode === "workit_timeout"
        && controlled?.requiresUserInput?.fallbackStopped === true
        && controlled?.requiresUserInput?.candidateCalls === 1
        && assertions.length > 0
        && assertions.every(Boolean)
        && receipt.unexpectedProcessFailures?.length === 0
        && !serialized.includes("canary-secret-must-not-escape"),
      workitVersion: receipt.release,
      workitCommit: receipt.source?.workitCommit,
      orynCommit: receipt.source?.orynCommit,
      tarballSha256: receipt.source?.workitTarball?.sha256,
      providerCalls: live?.providerCalls,
      decisions: decisions.map(({ candidateIndex, modelId, decision, reasonCode }) => ({
        candidateIndex,
        modelId,
        decision,
        reasonCode,
      })),
      replayOperationCalls: replay?.replayOperationCalls,
      providerCallsAfterReplay: replay?.providerCallsAfterReplay,
      sharedRetryBudget: controlled?.sharedRetryBudget,
      aggregateDeadline: controlled?.aggregateDeadline,
      requiresUserInput: controlled?.requiresUserInput,
      environmentWarnings: receipt.environment?.warnings?.map(({ code }) => code),
      limitations: receipt.limitations,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
