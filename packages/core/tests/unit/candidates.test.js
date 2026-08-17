/**
 * Candidate policy tests - verifies deterministic admission, classification,
 * quality decisions, and bounded evidence.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  firstAcceptable,
  classifyWorkItFailure,
} from "../../dist/candidates/index.js";
import {
  BudgetExceededError,
  CancellationError,
  TimeoutError,
  createBudget,
  group,
  run,
} from "../../dist/index.js";

const ACCEPT = Object.freeze({ accepted: true });
const RETRY = Object.freeze({ disposition: "retry_same_candidate", reasonCode: "temporary_failure" });
const NEXT = Object.freeze({ disposition: "try_next_candidate", reasonCode: "candidate_unavailable" });

function options(overrides = {}) {
  return {
    execute: async (candidate) => candidate,
    accept: async () => ACCEPT,
    classifyFailure: async () => NEXT,
    ...overrides,
  };
}

test("firstAcceptable returns the first semantically accepted candidate", async () => {
  const result = await firstAcceptable(["primary", "secondary"], options({
    execute: async (candidate, ctx) => ({ candidate, deadlineAt: ctx.deadlineAt }),
    accept: async (value) => value.candidate === "primary" ? ACCEPT : { accepted: false, reasonCode: "low_quality" },
  }));

  assert.equal(result.status, "accepted");
  assert.equal(result.candidate, "primary");
  assert.equal(result.candidateIndex, 0);
  assert.equal(result.value.candidate, "primary");
  assert.deepEqual(result.evidence.map(({ candidateIndex, decision, outcome }) => ({
    candidateIndex,
    decision,
    outcome,
  })), [{ candidateIndex: 0, decision: "accepted", outcome: "succeeded" }]);
  assert.equal(result.droppedEvidence, 0);
});

test("firstAcceptable retries only retry_same_candidate failures", async () => {
  const calls = [];
  const result = await firstAcceptable(["primary", "secondary"], options({
    execute: async (candidate, ctx) => {
      calls.push([candidate, ctx.attempt]);
      if (candidate === "primary") throw new Error("temporary");
      return candidate;
    },
    classifyFailure: async () => RETRY,
    retry: { times: 2, initialDelay: 0, jitter: false },
  }));

  assert.equal(result.status, "accepted");
  assert.equal(result.candidate, "secondary");
  assert.deepEqual(calls, [["primary", 1], ["primary", 2], ["secondary", 1]]);
  assert.deepEqual(result.evidence.map((attempt) => [attempt.candidateIndex, attempt.attempt, attempt.decision]), [
    [0, 1, "retry_same_candidate"],
    [0, 2, "retry_same_candidate"],
    [1, 1, "accepted"],
  ]);
});

test("firstAcceptable advances immediately after try_next_candidate", async () => {
  const calls = [];
  const result = await firstAcceptable(["primary", "secondary"], options({
    execute: async (candidate) => {
      calls.push(candidate);
      if (candidate === "primary") throw new Error("quota");
      return "ok";
    },
    retry: { times: 5, initialDelay: 0 },
  }));

  assert.equal(result.status, "accepted");
  assert.deepEqual(calls, ["primary", "secondary"]);
  assert.equal(result.evidence[0].reasonCode, "candidate_unavailable");
});

test("quality rejection is distinct from transport failure and advances", async () => {
  const result = await firstAcceptable([1, 2], options({
    accept: async (value) => value >= 2 ? ACCEPT : { accepted: false, reasonCode: "quality_too_low" },
  }));

  assert.equal(result.status, "accepted");
  assert.equal(result.value, 2);
  assert.deepEqual(result.evidence.map(({ decision, outcome, reasonCode }) => ({ decision, outcome, reasonCode })), [
    { decision: "quality_rejected", outcome: "succeeded", reasonCode: "quality_too_low" },
    { decision: "accepted", outcome: "succeeded", reasonCode: undefined },
  ]);
});

test("firstAcceptable returns exhausted for empty and fully rejected chains", async () => {
  const empty = await firstAcceptable([], options());
  const rejected = await firstAcceptable([1, 2], options({
    accept: async () => ({ accepted: false, reasonCode: "not_enough_evidence" }),
  }));

  assert.deepEqual(empty, { status: "exhausted", evidence: [], droppedEvidence: 0 });
  assert.equal(rejected.status, "exhausted");
  assert.deepEqual(rejected.evidence.map((attempt) => attempt.reasonCode), [
    "not_enough_evidence",
    "not_enough_evidence",
  ]);
});

test("terminal and requires_user_input decisions stop later candidates", async () => {
  const admitted = [];
  const terminalError = new Error("invalid request");
  const terminal = await firstAcceptable(["first", "never"], options({
    execute: async (candidate) => {
      admitted.push(candidate);
      throw terminalError;
    },
    classifyFailure: async () => ({ disposition: "terminal", reasonCode: "invalid_request" }),
  }));

  const userInput = await firstAcceptable(["first", "never"], options({
    execute: async () => { throw new Error("approval required"); },
    classifyFailure: async () => ({ disposition: "requires_user_input", reasonCode: "approval_required" }),
  }));

  assert.equal(terminal.status, "terminal");
  assert.equal(terminal.reasonCode, "invalid_request");
  assert.equal(terminal.error, terminalError);
  assert.deepEqual(admitted, ["first"]);
  assert.equal(userInput.status, "requires_user_input");
  assert.equal(userInput.reasonCode, "approval_required");
});

test("CancellationError always wins over caller classification", async () => {
  let classifications = 0;
  let secondStarted = false;
  const cancellation = new CancellationError({ kind: "manual", tag: "stop" });

  await assert.rejects(
    firstAcceptable(["first", "second"], options({
      execute: async (candidate) => {
        if (candidate === "second") secondStarted = true;
        throw cancellation;
      },
      classifyFailure: async () => {
        classifications++;
        return NEXT;
      },
    })),
    (error) => error === cancellation,
  );

  assert.equal(classifications, 0);
  assert.equal(secondStarted, false);
});

test("cancellation during retry backoff admits no next candidate", async () => {
  let scope;
  let secondStarted = false;

  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        scope = ctx.scope;
        setTimeout(() => scope.cancel("stop-backoff"), 5);
        await firstAcceptable(["first", "second"], options({
          execute: async (candidate) => {
            if (candidate === "second") secondStarted = true;
            throw new Error("retry me");
          },
          classifyFailure: async () => RETRY,
          retry: { times: 2, initialDelay: 1_000, jitter: false },
        }));
      });
    }),
    CancellationError,
  );

  assert.equal(secondStarted, false);
});

test("one absolute deadline is inherited without increasing across candidates", async () => {
  const deadlineAt = Date.now() + 1_000;
  const observed = [];
  const result = await firstAcceptable(["first", "second"], options({
    deadlineAt,
    execute: async (candidate, ctx) => {
      observed.push(ctx.deadlineAt);
      if (candidate === "first") throw new Error("next");
      return candidate;
    },
  }));

  assert.equal(result.status, "accepted");
  assert.deepEqual(observed, [deadlineAt, deadlineAt]);
});

test("aggregate deadline timeout is terminal and does not call the provider classifier", async () => {
  let classifications = 0;
  const result = await firstAcceptable(["slow"], options({
    deadlineAt: new Date(Date.now() + 10),
    execute: async (_candidate, ctx) => await new Promise((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
    }),
    classifyFailure: async () => {
      classifications++;
      return NEXT;
    },
  }));

  assert.equal(result.status, "terminal");
  assert.equal(result.reasonCode, "workit_timeout");
  assert.equal(classifications, 0);
});

test("shared retry budgets stop attempts before exceeding their invariant", async () => {
  const RetryBudget = createBudget("CandidateRetryBudget", { unit: "retries" });
  let calls = 0;

  await assert.rejects(
    run.context.with(
      RetryBudget,
      { limit: 1, spent: 0, unit: "retries" },
      async () => firstAcceptable(["first"], options({
        execute: async () => {
          calls++;
          throw new Error("retry");
        },
        classifyFailure: async () => RETRY,
        retry: { times: 3, initialDelay: 0, retryBudget: RetryBudget },
      })),
    ),
    BudgetExceededError,
  );

  assert.equal(calls, 2);
});

test("classifyWorkItFailure safely classifies known runtime errors", () => {
  assert.deepEqual(
    classifyWorkItFailure(new CancellationError({ kind: "manual", tag: "stop" })),
    { disposition: "cancelled", reasonCode: "workit_cancelled" },
  );
  assert.deepEqual(
    classifyWorkItFailure(new TimeoutError(10)),
    { disposition: "terminal", reasonCode: "workit_timeout" },
  );
  assert.deepEqual(
    classifyWorkItFailure(new BudgetExceededError({
      budgetKey: "CostBudget",
      limit: 1,
      spent: 2,
      attempted: 1,
    })),
    { disposition: "terminal", reasonCode: "workit_budget_exhausted" },
  );
  assert.equal(classifyWorkItFailure(new Error("provider")), undefined);
});

test("candidate evidence is bounded, redacted, cloned, and reports drops", async () => {
  const metadata = { provider: "primary", token: "secret", nested: { password: "hidden" } };
  const result = await firstAcceptable(["first"], options({
    execute: async () => { throw new Error("temporary"); },
    classifyFailure: async () => RETRY,
    retry: { times: 3, initialDelay: 0 },
    evidence: { maxAttempts: 1, maxMetadataBytes: 256 },
    candidateMetadata: () => metadata,
  }));

  metadata.provider = "mutated";
  assert.equal(result.status, "exhausted");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.droppedEvidence, 2);
  assert.deepEqual(result.evidence[0].metadata, {
    provider: "primary",
    token: "[redacted]",
    nested: { password: "[redacted]" },
    candidateIndex: 0,
  });
});

test("candidate evidence bounds error text and normalizes non-Error failures", async () => {
  const longMessage = "x".repeat(2_000);
  const stringFailure = await firstAcceptable(["first"], options({
    execute: async () => { throw longMessage; },
    classifyFailure: async () => ({ disposition: "terminal", reasonCode: "string_failure" }),
    retry: 1,
  }));
  const objectFailure = await firstAcceptable(["first"], options({
    execute: async () => { throw { code: 503 }; },
    classifyFailure: async () => ({ disposition: "terminal", reasonCode: "object_failure" }),
  }));

  assert.equal(stringFailure.status, "terminal");
  assert.equal(stringFailure.evidence[0].error.name, "Error");
  assert.equal(stringFailure.evidence[0].error.message.length, 1_024);
  assert.equal(objectFailure.status, "terminal");
  assert.equal(objectFailure.evidence[0].error.message, "Candidate attempt failed");
});

test("candidate contract rejects unsafe bounds, malformed decisions, and metadata", async () => {
  await assert.rejects(
    firstAcceptable([1, 2], options({ maxCandidates: 1 })),
    /candidates length exceeds maxCandidates/,
  );
  await assert.rejects(
    firstAcceptable([1], options({ maxCandidates: 0 })),
    /maxCandidates/,
  );
  await assert.rejects(
    firstAcceptable([1], options({ maxCandidates: 1.5 })),
    /maxCandidates/,
  );
  await assert.rejects(
    firstAcceptable([1], options({ maxCandidates: 1_001 })),
    /maxCandidates/,
  );
  await assert.rejects(
    firstAcceptable("not-an-array", options()),
    /candidates must be an array/,
  );
  await assert.rejects(
    firstAcceptable([], null),
    /options are required/,
  );
  await assert.rejects(
    firstAcceptable([], { execute: undefined, accept: undefined, classifyFailure: undefined }),
    /must be functions/,
  );
  await assert.rejects(
    firstAcceptable([1], options({ deadlineAt: Number.NaN })),
    /deadlineAt/,
  );
  await assert.rejects(
    firstAcceptable([1], options({
      accept: async () => ({ accepted: false, reasonCode: "NOT VALID" }),
    })),
    /reasonCode/,
  );
  await assert.rejects(
    firstAcceptable([1], options({ accept: async () => null })),
    /AcceptanceDecision/,
  );
  await assert.rejects(
    firstAcceptable([1], options({ accept: async () => ({ accepted: "yes" }) })),
    /AcceptanceDecision/,
  );
  await assert.rejects(
    firstAcceptable([1], options({
      execute: async () => { throw new Error("failure"); },
      classifyFailure: async () => ({ disposition: "unknown", reasonCode: "unknown" }),
    })),
    /disposition/,
  );
  await assert.rejects(
    firstAcceptable([1], options({
      execute: async () => { throw new Error("failure"); },
      classifyFailure: async () => null,
    })),
    /disposition/,
  );
  await assert.rejects(
    firstAcceptable([1], options({
      execute: async () => { throw new Error("failure"); },
      classifyFailure: async () => ({ disposition: "terminal", reasonCode: 1 }),
    })),
    /reasonCode/,
  );
  await assert.rejects(
    firstAcceptable([1], options({
      candidateMetadata: () => ({ payload: "x".repeat(1_000) }),
      evidence: { maxMetadataBytes: 32 },
    })),
    /maxMetadataBytes/,
  );
});

test("callback failures propagate as programmer errors instead of fallback", async () => {
  const classifierError = new Error("classifier bug");
  const acceptanceError = new Error("acceptance bug");

  await assert.rejects(
    firstAcceptable([1], options({
      execute: async () => { throw new Error("provider"); },
      classifyFailure: async () => { throw classifierError; },
    })),
    (error) => error === classifierError,
  );
  await assert.rejects(
    firstAcceptable([1], options({
      accept: async () => { throw acceptanceError; },
    })),
    (error) => error === acceptanceError,
  );
});
