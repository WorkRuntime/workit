/**
 * Correctness evidence: candidate failure, quality, cancellation, and budget policy.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BudgetExceededError,
  CancellationError,
  TimeoutError,
  createBudget,
  run,
} from "../../../dist/index.js";
import {
  classifyWorkItFailure,
  firstAcceptable,
} from "../../../dist/candidates/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-028",
  "candidate policy composes retry, quality rejection, and fallback",
  "transport retry and semantic rejection remain distinct before the first acceptable fallback is selected",
  async () => {
    let primaryCalls = 0;
    const result = await firstAcceptable(["primary", "fallback"], {
      execute: async (candidate) => {
        if (candidate === "primary" && ++primaryCalls === 1) throw new Error("temporary");
        return { candidate, score: candidate === "primary" ? 0.4 : 0.9 };
      },
      accept: async (value) => value.score >= 0.8
        ? { accepted: true }
        : { accepted: false, reasonCode: "score_too_low" },
      classifyFailure: async () => ({
        disposition: "retry_same_candidate",
        reasonCode: "temporary_failure",
      }),
      retry: { times: 2, initialDelay: 0, jitter: false },
      evidence: { maxAttempts: 8, maxMetadataBytes: 256 },
      candidateMetadata: (candidate) => ({ candidate, token: "secret" }),
    });

    const evidence = result.evidence.map((attempt) => ({
      candidateIndex: attempt.candidateIndex,
      attempt: attempt.attempt,
      decision: attempt.decision,
      outcome: attempt.outcome,
      reasonCode: attempt.reasonCode,
      token: attempt.metadata?.token,
    }));
    return {
      ok: result.status === "accepted"
        && result.candidate === "fallback"
        && result.droppedEvidence === 0
        && JSON.stringify(evidence) === JSON.stringify([
          {
            candidateIndex: 0,
            attempt: 1,
            decision: "retry_same_candidate",
            outcome: "failed",
            reasonCode: "temporary_failure",
            token: "[redacted]",
          },
          {
            candidateIndex: 0,
            attempt: 2,
            decision: "quality_rejected",
            outcome: "succeeded",
            reasonCode: "score_too_low",
            token: "[redacted]",
          },
          {
            candidateIndex: 1,
            attempt: 1,
            decision: "accepted",
            outcome: "succeeded",
            token: "[redacted]",
          },
        ]),
      status: result.status,
      evidence,
      droppedEvidence: result.droppedEvidence,
    };
  },
);

await suite.proof(
  "CORR-029",
  "candidate policy cannot convert cancellation into fallback",
  "real cancellation bypasses the provider classifier and no later candidate starts",
  async () => {
    let classifications = 0;
    const admitted = [];
    let observed;
    try {
      await firstAcceptable(["primary", "fallback"], {
        execute: async (candidate) => {
          admitted.push(candidate);
          throw new CancellationError({ kind: "manual", tag: "evidence-stop" });
        },
        accept: async () => ({ accepted: true }),
        classifyFailure: async () => {
          classifications++;
          return { disposition: "try_next_candidate", reasonCode: "incorrect_fallback" };
        },
      });
    } catch (error) {
      observed = error;
    }

    return {
      ok: observed instanceof CancellationError
        && observed.reason.kind === "manual"
        && observed.reason.tag === "evidence-stop"
        && classifications === 0
        && JSON.stringify(admitted) === JSON.stringify(["primary"]),
      classifications,
      admitted,
      cancellationReason: observed?.reason,
    };
  },
);

await suite.proof(
  "CORR-030",
  "candidate retries share the existing scope retry budget",
  "fallback candidates cannot admit a retry after the shared WorkIt budget is exhausted",
  async () => {
    const RetryBudget = createBudget("CandidateEvidenceRetryBudget", { unit: "retries" });
    let attempts = 0;
    let observed;
    try {
      await run.context.with(
        RetryBudget,
        { limit: 1, spent: 0, unit: "retries" },
        async () => firstAcceptable(["primary", "fallback"], {
          execute: async () => {
            attempts++;
            throw new Error("retry");
          },
          accept: async () => ({ accepted: true }),
          classifyFailure: async () => ({
            disposition: "retry_same_candidate",
            reasonCode: "retryable",
          }),
          retry: { times: 2, initialDelay: 0, jitter: false, retryBudget: RetryBudget },
        }),
      );
    } catch (error) {
      observed = error;
    }

    return {
      ok: observed instanceof BudgetExceededError && attempts === 3,
      attempts,
      errorName: observed?.name,
      budgetKey: observed?.budgetKey,
    };
  },
);

await suite.proof(
  "CORR-031",
  "candidate admission snapshots inputs and enforces an aggregate attempt cap",
  "callbacks cannot expand the admitted candidate set and unsafe candidate-count by retry-count products fail before execution",
  async () => {
    const candidates = ["original"];
    const admitted = [];
    const result = await firstAcceptable(candidates, {
      execute: async (candidate) => {
        admitted.push(candidate);
        candidates.push("injected");
        return candidate;
      },
      accept: async () => ({ accepted: false, reasonCode: "quality_rejected" }),
      classifyFailure: async () => ({ disposition: "try_next_candidate", reasonCode: "candidate_failed" }),
    });

    let unsafeError;
    try {
      await firstAcceptable(Array.from({ length: 11 }, (_, index) => index), {
        execute: async (candidate) => candidate,
        accept: async () => ({ accepted: true }),
        classifyFailure: async () => ({ disposition: "terminal", reasonCode: "unexpected_failure" }),
        maxCandidates: 11,
        retry: { times: 1_000 },
      });
    } catch (error) {
      unsafeError = error;
    }

    return {
      ok: result.status === "exhausted"
        && JSON.stringify(admitted) === JSON.stringify(["original"])
        && unsafeError instanceof RangeError,
      admitted,
      unsafeError: unsafeError?.message,
    };
  },
);

await suite.proof(
  "CORR-032",
  "candidate decisions are normalized once before policy action",
  "mutable decision getters cannot change disposition, reason, or acceptance after validation",
  async () => {
    let dispositionReads = 0;
    let reasonReads = 0;
    const failureDecision = {
      get disposition() {
        dispositionReads++;
        return dispositionReads === 1 ? "terminal" : "retry_same_candidate";
      },
      get reasonCode() {
        reasonReads++;
        return reasonReads === 1 ? "stable_reason" : "changed_reason";
      },
    };
    const failureResult = await firstAcceptable(["failure"], {
      execute: async () => { throw new Error("provider failed"); },
      accept: async () => ({ accepted: true }),
      classifyFailure: async () => failureDecision,
      retry: { times: 3, initialDelay: 0 },
    });

    let acceptedReads = 0;
    const acceptanceDecision = {
      get accepted() {
        acceptedReads++;
        return acceptedReads === 1;
      },
    };
    const acceptanceResult = await firstAcceptable(["accepted"], {
      execute: async (candidate) => candidate,
      accept: async () => acceptanceDecision,
      classifyFailure: async () => ({ disposition: "terminal", reasonCode: "unexpected_failure" }),
    });

    return {
      ok: failureResult.status === "terminal"
        && failureResult.reasonCode === "stable_reason"
        && dispositionReads === 1
        && reasonReads === 1
        && acceptanceResult.status === "accepted"
        && acceptedReads === 1,
      failureStatus: failureResult.status,
      failureReason: failureResult.status === "terminal" ? failureResult.reasonCode : null,
      dispositionReads,
      reasonReads,
      acceptanceStatus: acceptanceResult.status,
      acceptedReads,
    };
  },
);

await suite.proof(
  "CORR-033",
  "candidate error taxonomy classifies known WorkIt failures conservatively",
  "cancellation, timeout, and budget errors have stable built-in decisions while unknown provider errors remain caller-owned",
  async () => {
    const cancellation = classifyWorkItFailure(new CancellationError({ kind: "manual", tag: "taxonomy" }));
    const timeout = classifyWorkItFailure(new TimeoutError(10));
    const budget = classifyWorkItFailure(new BudgetExceededError({
      budgetKey: "TaxonomyBudget",
      limit: 1,
      spent: 2,
      attempted: 1,
    }));
    const unknown = classifyWorkItFailure(new Error("provider"));
    return {
      ok: JSON.stringify(cancellation) === JSON.stringify({
        disposition: "cancelled",
        reasonCode: "workit_cancelled",
      })
        && JSON.stringify(timeout) === JSON.stringify({
          disposition: "terminal",
          reasonCode: "workit_timeout",
        })
        && JSON.stringify(budget) === JSON.stringify({
          disposition: "terminal",
          reasonCode: "workit_budget_exhausted",
        })
        && unknown === undefined
        && Object.isFrozen(cancellation),
      cancellation,
      timeout,
      budget,
      unknown: unknown ?? null,
    };
  },
);

await suite.proof(
  "CORR-034",
  "candidate policy callback failures cannot silently become fallback",
  "quality and classifier callback bugs propagate unchanged and admit no later candidate",
  async () => {
    const qualityFailure = new Error("quality callback failed");
    const classifierFailure = new Error("classifier callback failed");
    const qualityAdmitted = [];
    const classifierAdmitted = [];
    let observedQuality;
    let observedClassifier;

    try {
      await firstAcceptable(["primary", "fallback"], {
        execute: async (candidate) => {
          qualityAdmitted.push(candidate);
          return candidate;
        },
        accept: async () => { throw qualityFailure; },
        classifyFailure: async () => ({ disposition: "try_next_candidate", reasonCode: "provider_failure" }),
      });
    } catch (error) {
      observedQuality = error;
    }

    try {
      await firstAcceptable(["primary", "fallback"], {
        execute: async (candidate) => {
          classifierAdmitted.push(candidate);
          throw new Error("provider failed");
        },
        accept: async () => ({ accepted: true }),
        classifyFailure: async () => { throw classifierFailure; },
      });
    } catch (error) {
      observedClassifier = error;
    }

    return {
      ok: observedQuality === qualityFailure
        && observedClassifier === classifierFailure
        && JSON.stringify(qualityAdmitted) === JSON.stringify(["primary"])
        && JSON.stringify(classifierAdmitted) === JSON.stringify(["primary"]),
      qualityFailurePreserved: observedQuality === qualityFailure,
      classifierFailurePreserved: observedClassifier === classifierFailure,
      qualityAdmitted,
      classifierAdmitted,
    };
  },
);

await suite.proof(
  "CORR-036",
  "hostile thrown values cannot bypass candidate classification",
  "proxy traps and throwing Error accessors are bounded while the caller classifier retains policy authority",
  async () => {
    const hostileProxy = new Proxy({}, {
      get() { throw new Error("hostile get"); },
      getPrototypeOf() { throw new Error("hostile prototype"); },
    });
    const hostileError = new Error("hidden");
    Object.defineProperties(hostileError, {
      name: { get: () => { throw new Error("hostile name"); } },
      message: { get: () => { throw new Error("hostile message"); } },
    });

    const reports = [];
    for (const failure of [hostileProxy, hostileError]) {
      const result = await firstAcceptable(["candidate"], {
        execute: async () => { throw failure; },
        accept: async () => ({ accepted: true }),
        classifyFailure: async () => ({ disposition: "terminal", reasonCode: "hostile_failure" }),
      });
      reports.push({
        status: result.status,
        reasonCode: result.status === "terminal" ? result.reasonCode : null,
        originalPreserved: result.status === "terminal" && result.error === failure,
      });
    }

    return {
      ok: reports.every((report) => report.status === "terminal"
        && report.reasonCode === "hostile_failure"
        && report.originalPreserved),
      reports,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
