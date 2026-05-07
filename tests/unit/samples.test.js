/**
 * Sample execution tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * These tests execute public samples against `dist/` so documentation examples
 * cannot drift away from the built package.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "vitest";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);

async function runSample(path) {
  const { stdout } = await execFileAsync(process.execPath, [path], {
    cwd: process.cwd(),
    timeout: 120_000,
  });
  return JSON.parse(stdout.trim());
}

test("sample: virtual billion-item stream stays bounded", async () => {
  const result = await runSample("samples/1b-stream.sample.js");

  assert.equal(result.sample, "1b-stream");
  assert.equal(result.total, 1_000_000_000);
  assert.equal(result.consumed, 25);
  assert.ok(result.produced <= 41);
  assert.ok(result.maxActive <= result.concurrency);
});

test("sample: high-concurrency budget accounting remains exact", async () => {
  const result = await runSample("samples/concurrency-budget.sample.js");

  assert.equal(result.sample, "concurrency-budget");
  assert.equal(result.total, 1_000);
  assert.equal(result.spent, 1_000);
  assert.ok(result.maxActive <= result.concurrency);
});

test("sample: task logging can be adapted to OTel-shaped records without core OTel imports", async () => {
  const result = await runSample("samples/logging-otel-bridge.sample.js");

  assert.equal(result.sample, "logging-otel-bridge");
  assert.equal(result.otelImported, false);
  assert.deepEqual(result.bodies, ["sample.import.started", "sample.import.skipped"]);
});

test("sample: one specific parallel task exposes progress events", async () => {
  const result = await runSample("samples/progress-parallel.sample.js");

  assert.equal(result.sample, "progress-parallel");
  assert.equal(result.target, "embed.batch.7");
  assert.equal(result.maxActive, result.concurrency);
  assert.deepEqual(result.progress.map((event) => event.pct), [0.25, 0.5, 0.75, 1]);
});

test("sample: cancellation reason is visible to scope and task", async () => {
  const result = await runSample("samples/cancel-reason.sample.js");

  assert.equal(result.sample, "cancel-reason");
  assert.deepEqual(result.scopeReason, { kind: "manual", tag: "user_stopped_request" });
  assert.deepEqual(result.taskReason, result.scopeReason);
});

test("sample: timeout aborts signal-aware work", async () => {
  const result = await runSample("samples/timeout-stop.sample.js");

  assert.equal(result.sample, "timeout-stop");
  assert.equal(result.stopped, true);
  assert.equal(result.reasonKind, "timeout");
});

test("sample: scoped background work is not orphaned", async () => {
  const result = await runSample("samples/no-orphan.sample.js");

  assert.equal(result.sample, "no-orphan");
  assert.equal(result.result, "body-returned");
  assert.equal(result.backgroundCompleted, true);
  assert.ok(result.elapsedMs >= 15);
});

test("sample: safer Promise.all cancels siblings and runs cleanup", async () => {
  const result = await runSample("samples/safer-promise-all.sample.js");

  assert.equal(result.sample, "safer-promise-all");
  assert.equal(result.slowCancelled, true);
  assert.equal(result.cleanupRan, true);
});

test("sample: agent tree cancellation cancels every tool and runs cleanup", async () => {
  const result = await runSample("samples/agent-tree-cancel.sample.js");

  assert.equal(result.sample, "agent-tree-cancel");
  assert.deepEqual(result.cancelled, ["browser", "code", "search"]);
  assert.deepEqual(result.cleanups, ["browser", "code", "search"]);
  assert.equal(result.reason.tag, "user_stopped_agent");
});

test("sample: provider race returns winner and cancels losers", async () => {
  const result = await runSample("samples/race-providers.sample.js");

  assert.equal(result.sample, "race-providers");
  assert.equal(result.winner, "anthropic");
  assert.deepEqual(result.cancelledProviders, ["gemini", "openai"]);
});

test("sample: budget-capped RAG composes race hedge budget and background audit", async () => {
  const result = await runSample("samples/budget-rag.sample.js");

  assert.equal(result.sample, "budget-rag");
  assert.equal(result.answer, "answer:keyword:structured concurrency");
  assert.equal(result.spent, 8);
  assert.equal(result.limit, 10);
  assert.deepEqual(result.audits, [{ rewritten: "structured concurrency", sources: 2 }]);
});

test("sample: resilient batch upload continues with item errors", async () => {
  const result = await runSample("samples/batch-upload.sample.js");

  assert.equal(result.sample, "batch-upload");
  assert.equal(result.mode, "continue");
  assert.equal(result.uploaded, 4);
  assert.deepEqual(result.errors, ["bad.txt"]);
  assert.equal(result.flakyAttempts, 2);
  assert.equal(result.maxActive, 3);
});

test("sample: supervised work restarts transient failures", async () => {
  const result = await runSample("samples/supervision.sample.js");

  assert.equal(result.sample, "supervision");
  assert.equal(result.result, "stable");
  assert.equal(result.attempts, 3);
});

test("sample: CPU-heavy work can opt into worker-thread execution", async () => {
  const result = await runSample("samples/worker-offload.sample.js");

  assert.equal(result.sample, "worker-offload");
  assert.deepEqual(result.values, [6_765, 10_946]);
  assert.ok(result.workerThreadIds.every((threadId) => threadId > 0));
});

test("sample: streaming summarizer produces only bounded input prefix", async () => {
  const result = await runSample("samples/streaming-summarizer.sample.js");

  assert.equal(result.sample, "streaming-summarizer");
  assert.equal(result.summaries, 12);
  assert.ok(result.produced <= 16);
  assert.equal(result.maxActive, 5);
  assert.equal(result.active, 0);
});

test("sample: 100k embeddings complete with bounded concurrency and token budget", async () => {
  const result = await runSample("samples/embed-100k.sample.js");

  assert.equal(result.sample, "embed-100k");
  assert.equal(result.total, 100_000);
  assert.equal(result.embedded, 100_000);
  assert.equal(result.concurrency, 32);
  assert.equal(result.maxActive, 32);
  assert.equal(result.tokensSpent, 100_000);
});

test("sample: bad-batch bisection isolates failed embeddings", async () => {
  const result = await runSample("samples/embed-bisection.sample.js");

  assert.equal(result.sample, "embed-bisection");
  assert.deepEqual(result.vectors, [[5], [5]]);
  assert.deepEqual(result.errorIndexes, [1]);
  assert.equal(result.tokensSpent, 17);
  assert.deepEqual(result.calls, [
    ["alpha", "bad-doc", "gamma"],
    ["alpha", "bad-doc"],
    ["alpha"],
    ["bad-doc"],
    ["gamma"],
  ]);
});

test("sample: live STT disconnect cancels provider and closes audio source", async () => {
  const result = await runSample("samples/stt-disconnect.sample.js");

  assert.equal(result.sample, "stt-disconnect");
  assert.equal(result.first, "FIRST");
  assert.equal(result.providerCancelled, true);
  assert.equal(result.sourceClosed, true);
  assert.equal(result.reasonKind, "manual");
});

test("sample: AWS Lambda-style handler imports WorkJS as an SDK", async () => {
  const result = await runSample("samples/aws-lambda-handler.sample.js");

  assert.equal(result.sample, "aws-lambda-handler");
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(JSON.parse(result.response.body), { processed: 2, failed: 0, bytes: 11 });
});

test("sample: Azure Functions-style handler imports WorkJS as an SDK", async () => {
  const result = await runSample("samples/azure-functions-handler.sample.js");

  assert.equal(result.sample, "azure-functions-handler");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.response.jsonBody.greetings, ["hello aws", "hello azure", "hello next"]);
});

test("sample: Next.js server route-style handler imports WorkJS as an SDK", async () => {
  const result = await runSample("samples/next-server-route.sample.js");

  assert.equal(result.sample, "next-server-route");
  assert.deepEqual(result.response, {
    query: "structured concurrency",
    provider: "fast-provider",
  });
});

test("sample: OpenTelemetry adapter creates spans and metrics", async () => {
  const result = await runSample("samples/otel-adapter.sample.js");

  assert.equal(result.sample, "otel-adapter");
  assert.deepEqual(result.spans, [{
    name: "workjs.task.sample.otel",
    ended: true,
    events: ["workjs.task.progress"],
  }]);
  assert.ok(result.metricNames.includes("workjs.task.total"));
  assert.ok(result.metricNames.includes("workjs.task.duration"));
});
