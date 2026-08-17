/**
 * Bounded operational scenarios for the candidate policy contract.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { CancellationError, group } from "../../../dist/index.js";
import { firstAcceptable } from "../../../dist/candidates/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-037",
  "candidate policy composes bounded operational decision scenarios",
  "quality fallback, caller-owned idempotency, user-input stops, and cooperative cancellation preserve their declared boundaries",
  async () => {
    const reports = [
      await runQualityFallback(),
      await runCallerOwnedIdempotency(),
      await runUserInputStop(),
      await runCancellation(),
    ];
    return {
      ok: reports.every((report) => report.status === "pass"),
      reports,
      limitation: "These are bounded in-process operational fixtures, not a provider, durable-store, or Oryn production canary.",
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

async function runQualityFallback() {
  const calls = [];
  const result = await firstAcceptable(["reasoning", "balanced"], {
    execute: async (model, ctx) => {
      calls.push({ model, attempt: ctx.attempt, deadlineAt: ctx.deadlineAt });
      if (model === "reasoning" && ctx.attempt === 1) throw new Error("provider overloaded");
      return { model, groundedness: model === "reasoning" ? 0.63 : 0.91 };
    },
    accept: async (answer) => answer.groundedness >= 0.85
      ? { accepted: true }
      : { accepted: false, reasonCode: "groundedness_too_low" },
    classifyFailure: async () => ({
      disposition: "retry_same_candidate",
      reasonCode: "provider_overloaded",
    }),
    retry: { times: 2, initialDelay: 0, jitter: false },
    deadlineAt: Date.now() + 5_000,
  });
  const decisions = result.evidence.map((attempt) => attempt.decision);
  return {
    name: "quality-fallback",
    status: result.status === "accepted"
      && result.candidate === "balanced"
      && JSON.stringify(decisions) === JSON.stringify([
        "retry_same_candidate",
        "quality_rejected",
        "accepted",
      ])
      && calls.every((call) => typeof call.deadlineAt === "number")
      ? "pass"
      : "fail",
    selected: result.status === "accepted" ? result.candidate : null,
    decisions,
  };
}

async function runCallerOwnedIdempotency() {
  const inProcessStore = new Map();
  let providerCalls = 0;
  const result = await firstAcceptable(["payments-primary"], {
    execute: async (_provider, ctx) => {
      providerCalls++;
      const idempotencyKey = "order-1042";
      const existing = inProcessStore.get(idempotencyKey);
      if (existing !== undefined) return existing;
      const charge = { chargeId: "charge-1042", settled: true };
      inProcessStore.set(idempotencyKey, charge);
      if (ctx.attempt === 1) throw new Error("response lost after commit");
      return charge;
    },
    accept: async (charge) => charge.settled
      ? { accepted: true }
      : { accepted: false, reasonCode: "charge_not_settled" },
    classifyFailure: async () => ({ disposition: "retry_same_candidate", reasonCode: "response_lost" }),
    retry: { times: 2, initialDelay: 0, jitter: false },
  });
  return {
    name: "caller-owned-idempotency",
    status: result.status === "accepted" && providerCalls === 2 && inProcessStore.size === 1 ? "pass" : "fail",
    providerCalls,
    sideEffects: inProcessStore.size,
    store: "bounded-in-process-fixture",
  };
}

async function runUserInputStop() {
  const admitted = [];
  const result = await firstAcceptable(["restricted-tool", "unsafe-fallback"], {
    execute: async (candidate) => {
      admitted.push(candidate);
      throw new Error("approval required");
    },
    accept: async () => ({ accepted: true }),
    classifyFailure: async () => ({
      disposition: "requires_user_input",
      reasonCode: "tool_approval_required",
    }),
  });
  return {
    name: "user-input-stop",
    status: result.status === "requires_user_input"
      && JSON.stringify(admitted) === JSON.stringify(["restricted-tool"])
      ? "pass"
      : "fail",
    admitted,
    reasonCode: result.status === "requires_user_input" ? result.reasonCode : null,
  };
}

async function runCancellation() {
  const admitted = [];
  let observed;
  try {
    await group(async (spawn) => spawn(async (ctx) => {
      setTimeout(() => ctx.scope.cancel("request-disconnected"), 5);
      await firstAcceptable(["slow-primary", "fallback"], {
        execute: async (candidate, candidateCtx) => {
          admitted.push(candidate);
          await new Promise((_resolve, reject) => {
            candidateCtx.signal.addEventListener("abort", () => reject(candidateCtx.signal.reason), { once: true });
          });
        },
        accept: async () => ({ accepted: true }),
        classifyFailure: async () => ({ disposition: "try_next_candidate", reasonCode: "provider_failed" }),
      });
    }));
  } catch (error) {
    observed = error;
  }
  return {
    name: "cooperative-cancellation",
    status: observed instanceof CancellationError
      && JSON.stringify(admitted) === JSON.stringify(["slow-primary"])
      ? "pass"
      : "fail",
    admitted,
    cancellationKind: observed?.reason?.kind,
  };
}
