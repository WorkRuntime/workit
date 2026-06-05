/**
 * Machine-readable claim fixtures for executable samples.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Each fixture ties one product claim to a sample and a deterministic output
 * assertion. Release verification runs this file through
 * `scripts/check-claim-fixtures.mjs`.
 */

export const claimFixtures = [
  {
    id: "real-cancellation-reason",
    sample: "samples/cancel-reason.sample.js",
    proves: "Manual cancellation reaches task and scope observers with a typed reason.",
    verify(result) {
      assertEqual(result.scopeReason?.kind, "manual", "scope cancel reason kind");
      assertEqual(result.taskReason?.tag, "user_stopped_request", "task cancel reason tag");
    },
  },
  {
    id: "automatic-cleanup-on-cancel",
    sample: "samples/agent-tree-cancel.sample.js",
    proves: "Cancelling an agent-like scope cancels every owned child and runs cleanup.",
    verify(result) {
      assertArrayEqual(result.cancelled, ["browser", "code", "search"], "cancelled tools");
      assertArrayEqual(result.cleanups, ["browser", "code", "search"], "cleanup order set");
    },
  },
  {
    id: "safer-promise-all",
    sample: "samples/safer-promise-all.sample.js",
    proves: "Sibling failure cancels slower siblings and waits for their cleanup.",
    verify(result) {
      assertEqual(result.slowCancelled, true, "slow sibling cancellation");
      assertEqual(result.cleanupRan, true, "slow sibling cleanup");
    },
  },
  {
    id: "race-cancels-losers",
    sample: "samples/race-providers.sample.js",
    proves: "Provider races return the first result and cancel non-winning providers.",
    verify(result) {
      assertEqual(result.winner, "anthropic", "race winner");
      assertArrayEqual(result.cancelledProviders, ["gemini", "openai"], "cancelled providers");
    },
  },
  {
    id: "bounded-concurrency",
    sample: "samples/concurrency-budget.sample.js",
    proves: "Parallel work respects the configured concurrency cap.",
    verify(result) {
      assertEqual(result.total, 1_000, "total work");
      assert(result.maxActive <= result.concurrency, "max active must not exceed concurrency");
    },
  },
  {
    id: "timeout-stops-work",
    sample: "samples/timeout-stop.sample.js",
    proves: "Timeouts abort signal-aware task bodies.",
    verify(result) {
      assertEqual(result.stopped, true, "timeout stopped work");
      assertEqual(result.reasonKind, "timeout", "timeout reason");
    },
  },
  {
    id: "no-orphan-scoped-background",
    sample: "samples/no-orphan.sample.js",
    proves: "Scoped background work is owned and awaited before scope completion.",
    verify(result) {
      assertEqual(result.backgroundCompleted, true, "background completion");
      assert(result.elapsedMs >= 15, "scope waited for background work");
    },
  },
  {
    id: "progress-for-specific-task",
    sample: "samples/progress-parallel.sample.js",
    proves: "Progress can be observed for a specific task inside parallel work.",
    verify(result) {
      assertEqual(result.target, "embed.batch.7", "target task");
      assertArrayEqual(result.progress.map((event) => event.pct), [0.25, 0.5, 0.75, 1], "progress percentages");
    },
  },
  {
    id: "stream-backpressure",
    sample: "samples/1b-stream.sample.js",
    proves: "A virtual one-billion-item source is consumed lazily under backpressure.",
    verify(result) {
      assertEqual(result.total, 1_000_000_000, "virtual source size");
      assertEqual(result.consumed, 25, "consumer stop count");
      assert(result.produced <= 41, "producer must stay bounded after early stop");
    },
  },
  {
    id: "resilient-batch-upload",
    sample: "samples/batch-upload.sample.js",
    proves: "Bounded batch work can retry and continue with typed item errors.",
    verify(result) {
      assertEqual(result.mode, "continue", "batch mode");
      assertEqual(result.uploaded, 4, "uploaded count");
      assertArrayEqual(result.errors, ["bad.txt"], "item errors");
    },
  },
  {
    id: "bad-batch-bisection",
    sample: "samples/embed-bisection.sample.js",
    proves: "Embedding batch failures can be bisected to isolate bad documents.",
    verify(result) {
      assertArrayEqual(result.errorIndexes, [1], "bad document index");
      assertEqual(result.vectors.length, 2, "successful vectors");
    },
  },
  {
    id: "live-stt-disconnect-cleanup",
    sample: "samples/stt-disconnect.sample.js",
    proves: "Live stream disconnects abort provider work and close the source.",
    verify(result) {
      assertEqual(result.providerCancelled, true, "provider cancellation");
      assertEqual(result.sourceClosed, true, "source cleanup");
    },
  },
  {
    id: "worker-thread-offload",
    sample: "samples/worker-offload.sample.js",
    proves: "CPU-heavy jobs can opt into worker-thread execution.",
    verify(result) {
      assertArrayEqual(result.values, [6_765, 10_946], "worker results");
      assert(result.workerThreadIds.every((threadId) => threadId > 0), "work must run on worker threads");
    },
  },
  {
    id: "aws-handler-import",
    sample: "samples/aws-lambda-handler.sample.js",
    proves: "AWS Lambda-shaped handlers can import WorkIt as an SDK.",
    verify(result) {
      assertEqual(result.response.statusCode, 200, "AWS handler status");
      assertEqual(JSON.parse(result.response.body).processed, 2, "AWS processed count");
    },
  },
  {
    id: "azure-handler-import",
    sample: "samples/azure-functions-handler.sample.js",
    proves: "Azure Functions-shaped handlers can import WorkIt as an SDK.",
    verify(result) {
      assertEqual(result.response.status, 200, "Azure handler status");
      assertArrayEqual(result.response.jsonBody.greetings, ["hello aws", "hello azure", "hello next"], "Azure handler greetings");
    },
  },
  {
    id: "next-route-import",
    sample: "samples/next-server-route.sample.js",
    proves: "Next.js server route-shaped handlers can import WorkIt as an SDK.",
    verify(result) {
      assertEqual(result.response.provider, "fast-provider", "Next route provider");
      assertEqual(result.response.query, "structured concurrency", "Next route query");
    },
  },
  {
    id: "otel-adapter",
    sample: "samples/otel-adapter.sample.js",
    proves: "The optional OTel adapter emits spans and bounded metrics.",
    verify(result) {
      assertEqual(result.spans[0]?.ended, true, "span ended");
      assert(result.metricNames.includes("workit.task.total"), "task total metric");
    },
  },
];

function assert(value, message) {
  if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertArrayEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}
