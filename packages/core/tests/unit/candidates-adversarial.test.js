/**
 * Adversarial candidate policy tests - exercises mutable and hostile inputs.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  classifyWorkItFailure,
  firstAcceptable,
} from "../../dist/candidates/index.js";
import { CancellationError } from "../../dist/index.js";

const ACCEPT = Object.freeze({ accepted: true });

function base(overrides = {}) {
  return {
    execute: async (candidate) => candidate,
    accept: async () => ACCEPT,
    classifyFailure: async () => ({ disposition: "try_next_candidate", reasonCode: "next_candidate" }),
    ...overrides,
  };
}

test("candidate admission snapshots the input array before callbacks can expand it", async () => {
  const candidates = ["original"];
  const admitted = [];
  const result = await firstAcceptable(candidates, base({
    execute: async (candidate) => {
      admitted.push(candidate);
      candidates.push(...Array.from({ length: 100 }, (_, index) => `injected-${index}`));
      return candidate;
    },
    accept: async () => ({ accepted: false, reasonCode: "quality_rejected" }),
  }));

  assert.equal(result.status, "exhausted");
  assert.deepEqual(admitted, ["original"]);
});

test("failure decisions are normalized once and cannot change after validation", async () => {
  let dispositionReads = 0;
  let reasonReads = 0;
  let attempts = 0;
  const mutableDecision = {
    get disposition() {
      dispositionReads++;
      return dispositionReads === 1 ? "terminal" : "retry_same_candidate";
    },
    get reasonCode() {
      reasonReads++;
      return reasonReads === 1 ? "stable_reason" : "changed_reason";
    },
  };

  const result = await firstAcceptable(["candidate"], base({
    execute: async () => {
      attempts++;
      throw new Error("failure");
    },
    classifyFailure: async () => mutableDecision,
    retry: { times: 3, initialDelay: 0 },
  }));

  assert.equal(result.status, "terminal");
  assert.equal(result.reasonCode, "stable_reason");
  assert.equal(attempts, 1);
  assert.equal(dispositionReads, 1);
  assert.equal(reasonReads, 1);
});

test("acceptance decisions are normalized once and resist getter time-of-check changes", async () => {
  let acceptedReads = 0;
  const decision = {
    get accepted() {
      acceptedReads++;
      return acceptedReads === 1;
    },
  };

  const result = await firstAcceptable(["candidate"], base({
    accept: async () => decision,
  }));

  assert.equal(result.status, "accepted");
  assert.equal(acceptedReads, 1);
});

test("built-in classifications are immutable shared constants", () => {
  const cancellation = new CancellationError({ kind: "manual", tag: "stop" });
  const first = classifyWorkItFailure(cancellation);

  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => {
    first.disposition = "try_next_candidate";
  }, TypeError);
  assert.deepEqual(classifyWorkItFailure(cancellation), {
    disposition: "cancelled",
    reasonCode: "workit_cancelled",
  });
});

test("candidate execution snapshots callback and retry policy references", async () => {
  const retry = { times: 1, initialDelay: 0 };
  const opts = base({
    execute: async () => {
      opts.classifyFailure = async () => ({ disposition: "terminal", reasonCode: "mutated_classifier" });
      retry.times = 100;
      throw new Error("failure");
    },
    classifyFailure: async () => ({ disposition: "try_next_candidate", reasonCode: "snapshotted_classifier" }),
    retry,
  });

  const result = await firstAcceptable(["candidate"], opts);

  assert.equal(result.status, "exhausted");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].reasonCode, "snapshotted_classifier");
});

test("aggregate attempt admission rejects unsafe products and invalid empty-chain retry policy", async () => {
  await assert.rejects(
    firstAcceptable(Array.from({ length: 11 }, (_, index) => index), base({
      retry: { times: 1_000 },
      maxCandidates: 11,
    })),
    /total candidate attempts/,
  );
  await assert.rejects(
    firstAcceptable([], base({ retry: { times: 0 } })),
    /retry attempts/,
  );
  await assert.rejects(
    firstAcceptable([], base({ retry: { times: 1, retryIf: () => true } })),
    /retryIf/,
  );
  await assert.rejects(
    firstAcceptable([], base({ candidateMetadata: "invalid" })),
    /candidateMetadata/,
  );
  await assert.rejects(
    firstAcceptable(["candidate"], base({ candidateMetadata: () => [] })),
    /candidateMetadata must return an object/,
  );

  const validFullRetryPolicy = await firstAcceptable(["candidate"], base({
    retry: {
      times: 1,
      backoff: "fixed",
      initialDelay: 0,
      maxDelay: 0,
      jitter: false,
    },
  }));
  assert.equal(validFullRetryPolicy.status, "accepted");
});

test("hostile thrown proxies and Error accessors cannot bypass caller classification", async () => {
  const hostileProxy = new Proxy({}, {
    get() {
      throw new Error("hostile get");
    },
    getPrototypeOf() {
      throw new Error("hostile prototype");
    },
  });
  const hostileError = new Error("hidden");
  Object.defineProperties(hostileError, {
    name: { get: () => { throw new Error("hostile name"); } },
    message: { get: () => { throw new Error("hostile message"); } },
  });
  let classifications = 0;

  for (const failure of [hostileProxy, hostileError]) {
    const result = await firstAcceptable(["candidate"], base({
      execute: async () => { throw failure; },
      classifyFailure: async () => {
        classifications++;
        return { disposition: "terminal", reasonCode: "hostile_failure" };
      },
    }));
    assert.equal(result.status, "terminal");
    assert.equal(result.error, failure);
  }
  assert.equal(classifications, 2);
});

test("cancellation raised inside quality or classification callbacks remains authoritative", async () => {
  const qualityCancellation = new CancellationError({ kind: "manual", tag: "quality-cancel" });
  const classifierCancellation = new CancellationError({ kind: "manual", tag: "classifier-cancel" });

  await assert.rejects(
    firstAcceptable(["candidate"], base({
      accept: async () => { throw qualityCancellation; },
    })),
    (error) => error === qualityCancellation,
  );
  await assert.rejects(
    firstAcceptable(["candidate"], base({
      execute: async () => { throw new Error("provider"); },
      classifyFailure: async () => { throw classifierCancellation; },
    })),
    (error) => error === classifierCancellation,
  );
});

test("metadata named __proto__ stays inert after normalization", async () => {
  const metadata = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const result = await firstAcceptable(["candidate"], base({
    candidateMetadata: () => metadata,
  }));

  assert.equal(result.status, "accepted");
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(result.evidence[0].metadata.__proto__.polluted, true);
});
