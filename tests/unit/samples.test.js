/**
 * Sample execution tests.
 *
 * @author Admilson B. F. Cossa
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
