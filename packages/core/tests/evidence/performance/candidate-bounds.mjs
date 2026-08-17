/**
 * Performance evidence for bounded candidate attempts and retained evidence.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from "node:perf_hooks";
import { firstAcceptable } from "../../../dist/candidates/index.js";
import { createSuite } from "../harness.mjs";

const QUALITY_CANDIDATES = 1_000;
const RETRY_CANDIDATES = 25;
const RETRIES_PER_CANDIDATE = 10;
const EVIDENCE_LIMIT = 32;
const MAX_QUALITY_CHAIN_MS = 5_000;
const MAX_RETRY_CHAIN_MS = 8_000;
const MAX_RETAINED_HEAP_BYTES = 32 * 1024 * 1024;

if (typeof globalThis.gc !== "function") {
  throw new Error("candidate performance evidence requires node --expose-gc");
}

const suite = createSuite("performance");

await suite.proof(
  "PERF-003",
  "candidate execution and retained evidence remain bounded",
  "large quality and retry chains stay inside time and retained-heap budgets while evidence retains only its configured window",
  async () => {
    const quality = await measure(async () => firstAcceptable(
      Array.from({ length: QUALITY_CANDIDATES }, (_, index) => index),
      {
        execute: async (candidate) => candidate,
        accept: async () => ({ accepted: false, reasonCode: "quality_rejected" }),
        classifyFailure: async () => ({ disposition: "terminal", reasonCode: "unexpected_failure" }),
        maxCandidates: QUALITY_CANDIDATES,
        evidence: { maxAttempts: EVIDENCE_LIMIT },
      },
    ));

    let retryAttempts = 0;
    const retry = await measure(async () => firstAcceptable(
      Array.from({ length: RETRY_CANDIDATES }, (_, index) => index),
      {
        execute: async () => {
          retryAttempts++;
          throw new Error("retryable");
        },
        accept: async () => ({ accepted: true }),
        classifyFailure: async () => ({ disposition: "retry_same_candidate", reasonCode: "retryable" }),
        retry: { times: RETRIES_PER_CANDIDATE, initialDelay: 0, jitter: false },
        maxCandidates: RETRY_CANDIDATES,
        evidence: { maxAttempts: EVIDENCE_LIMIT },
      },
    ));

    const expectedRetryAttempts = RETRY_CANDIDATES * RETRIES_PER_CANDIDATE;
    const qualityReport = summarize(quality, QUALITY_CANDIDATES);
    const retryReport = summarize(retry, expectedRetryAttempts);
    return {
      ok: quality.value.status === "exhausted"
        && qualityReport.evidenceEntries === EVIDENCE_LIMIT
        && qualityReport.droppedEvidence === QUALITY_CANDIDATES - EVIDENCE_LIMIT
        && qualityReport.elapsedMs <= MAX_QUALITY_CHAIN_MS
        && qualityReport.retainedHeapBytes <= MAX_RETAINED_HEAP_BYTES
        && retry.value.status === "exhausted"
        && retryAttempts === expectedRetryAttempts
        && retryReport.evidenceEntries === EVIDENCE_LIMIT
        && retryReport.droppedEvidence === expectedRetryAttempts - EVIDENCE_LIMIT
        && retryReport.elapsedMs <= MAX_RETRY_CHAIN_MS
        && retryReport.retainedHeapBytes <= MAX_RETAINED_HEAP_BYTES,
      quality: qualityReport,
      retry: retryReport,
      limits: {
        evidenceEntries: EVIDENCE_LIMIT,
        retainedHeapBytes: MAX_RETAINED_HEAP_BYTES,
        qualityChainMs: MAX_QUALITY_CHAIN_MS,
        retryChainMs: MAX_RETRY_CHAIN_MS,
      },
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

async function measure(operation) {
  globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const value = await operation();
  const elapsedMs = Math.round(performance.now() - startedAt);
  globalThis.gc();
  const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  return { value, elapsedMs, retainedHeapBytes };
}

function summarize(measurement, attempts) {
  return {
    attempts,
    elapsedMs: measurement.elapsedMs,
    retainedHeapBytes: measurement.retainedHeapBytes,
    evidenceEntries: measurement.value.evidence.length,
    droppedEvidence: measurement.value.droppedEvidence,
  };
}
