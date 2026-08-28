/**
 * Property tests for candidate admission and evidence invariants.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { firstAcceptable } from "../../dist/candidates/index.js";
import { PROPERTY_RUNS, propertySeed } from "./config.js";

test("property: candidate attempts never exceed maxCandidates times retry attempts", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        candidateCount: fc.integer({ min: 0, max: 8 }),
        retryTimes: fc.integer({ min: 1, max: 4 }),
      }),
      async ({ candidateCount, retryTimes }) => {
        const candidates = Array.from({ length: candidateCount }, (_, index) => index);
        let attempts = 0;
        const result = await firstAcceptable(candidates, {
          execute: async () => {
            attempts++;
            throw new Error("retryable");
          },
          accept: async () => ({ accepted: true }),
          classifyFailure: async () => ({
            disposition: "retry_same_candidate",
            reasonCode: "retryable",
          }),
          retry: { times: retryTimes, initialDelay: 0, jitter: false },
          maxCandidates: Math.max(1, candidateCount),
          evidence: { maxAttempts: Math.max(1, candidateCount * retryTimes) },
        });

        assert.equal(result.status, "exhausted");
        assert.equal(attempts, candidateCount * retryTimes);
        assert.ok(attempts <= Math.max(1, candidateCount) * retryTimes);
        assert.equal(result.evidence.length, attempts);
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: propertySeed(0xCA7D01) },
  );
});

test("property: accepted results come from the first admitted acceptable candidate", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 12 }).chain((candidateCount) => fc.record({
        candidateCount: fc.constant(candidateCount),
        acceptedIndex: fc.integer({ min: 0, max: candidateCount - 1 }),
      })),
      async ({ candidateCount, acceptedIndex }) => {
        const candidates = Array.from({ length: candidateCount }, (_, index) => `candidate-${index}`);
        const admitted = [];
        const result = await firstAcceptable(candidates, {
          execute: async (candidate) => {
            admitted.push(candidate);
            return candidate;
          },
          accept: async (_value, _candidate, ctx) => ctx.name === "candidate"
            && admitted.length - 1 === acceptedIndex
            ? { accepted: true }
            : { accepted: false, reasonCode: "quality_rejected" },
          classifyFailure: async () => ({ disposition: "terminal", reasonCode: "unexpected_failure" }),
          maxCandidates: candidateCount,
        });

        assert.equal(result.status, "accepted");
        assert.equal(result.candidateIndex, acceptedIndex);
        assert.equal(result.candidate, candidates[acceptedIndex]);
        assert.deepEqual(admitted, candidates.slice(0, acceptedIndex + 1));
        assert.deepEqual(
          result.evidence.map((attempt) => attempt.candidateIndex),
          Array.from({ length: acceptedIndex + 1 }, (_, index) => index),
        );
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: propertySeed(0xCA7D02) },
  );
});

test("property: stopping dispositions never admit a later candidate", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("terminal", "requires_user_input"),
      async (disposition) => {
        const admitted = [];
        const result = await firstAcceptable([0, 1, 2], {
          execute: async (candidate) => {
            admitted.push(candidate);
            throw new Error("stop");
          },
          accept: async () => ({ accepted: true }),
          classifyFailure: async () => ({ disposition, reasonCode: "selection_stopped" }),
        });

        assert.equal(result.status, disposition);
        assert.deepEqual(admitted, [0]);
        assert.deepEqual(result.evidence.map((attempt) => attempt.candidateIndex), [0]);
      },
    ),
    { numRuns: PROPERTY_RUNS, seed: propertySeed(0xCA7D03) },
  );
});
