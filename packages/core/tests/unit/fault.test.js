/**
 * Fault-injection harness tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  cancellationStorm,
  cleanupHang,
  providerTimeout,
  retryExhaustion,
  runFaultScenario,
  runFaultSuite,
} from "../../dist/fault/index.js";

test("Given cancellation storm scenario, harness records cancelled owned tasks", async () => {
  const report = await runFaultScenario(cancellationStorm({
    taskCount: 3,
    cancelAfter: 1,
    workerDuration: 50,
  }), { receiptId: "fault-cancel" });

  assert.equal(report.status, "pass");
  assert.equal(report.receipt.terminal.outcome, "cancelled");
  assert.equal(report.findings.length, 0);
  assert.equal(report.receipt.events.filter((event) => event.type === "task:cancelled").length >= 3, true);
  assert.equal(report.observations.some((event) => event.type === "fault:injected"), true);
});

test("Given cleanup hang scenario, harness records bounded cleanup timeout evidence", async () => {
  const report = await runFaultScenario(cleanupHang({ cleanupTimeout: "5ms" }), {
    receiptId: "fault-cleanup",
  });

  assert.equal(report.status, "pass");
  assert.equal(report.receipt.summary.cleanupTimeouts, 1);
  assert.equal(report.analysis.status, "warn");
  assert.equal(report.protocol.status, "pass");
});

test("Given provider timeout scenario, harness treats the expected timeout as observed evidence", async () => {
  const report = await runFaultScenario(providerTimeout({
    timeout: 5,
    providerLatency: 50,
  }), { receiptId: "fault-provider-timeout" });

  assert.equal(report.status, "pass");
  assert.equal(report.error.name, "TimeoutError");
  assert.equal(
    report.receipt.events.some((event) => event.type === "task:failed" && event.error?.name === "TimeoutError"),
    true,
  );
});

test("Given retry exhaustion scenario, harness records every retry attempt before failure", async () => {
  const report = await runFaultScenario(retryExhaustion({
    attempts: 3,
    initialDelay: 1,
  }), { receiptId: "fault-retry" });

  assert.equal(report.status, "pass");
  assert.equal(report.error.name, "Error");
  assert.equal(report.receipt.events.filter((event) => event.type === "task:retrying").length, 2);
});

test("Given a fault suite, harness aggregates pass and fail counts", async () => {
  const suite = await runFaultSuite([
    cleanupHang({ cleanupTimeout: 5 }),
    retryExhaustion({ attempts: 2, initialDelay: 1 }),
  ]);

  assert.equal(suite.passed, 2);
  assert.equal(suite.failed, 0);
  assert.deepEqual(suite.reports.map((report) => report.status), ["pass", "pass"]);
});

test("Given default and custom fault options, builders normalize stable scenario contracts", () => {
  assert.equal(cancellationStorm().taskCount, 8);
  assert.equal(cancellationStorm({ id: "storm-custom" }).id, "storm-custom");
  assert.equal(cleanupHang().id, "fault:cleanup-hang");
  assert.equal(cleanupHang({ id: "cleanup-custom" }).id, "cleanup-custom");
  assert.equal(providerTimeout().id, "fault:provider-timeout");
  assert.equal(providerTimeout({ id: "provider-custom" }).id, "provider-custom");
  assert.equal(retryExhaustion().attempts, 3);
  assert.equal(retryExhaustion({ id: "retry-custom" }).id, "retry-custom");
});

test("Given truncated fault evidence, harness returns an explicit failing report", async () => {
  const report = await runFaultScenario(cancellationStorm({
    taskCount: 1,
    cancelAfter: 1,
    workerDuration: 50,
  }), {
    maxEvents: 1,
    receiptId: "fault-truncated",
  });

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "expected_cancellation_not_observed"), true);
});

test("Given truncated cleanup evidence, harness reports the missing cleanup timeout", async () => {
  const report = await runFaultScenario(cleanupHang({ cleanupTimeout: 5 }), {
    maxEvents: 1,
    receiptId: "fault-cleanup-truncated",
  });

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "cleanup_timeout_not_observed"), true);
});

test("Given provider timeout scenario that does not time out, harness reports missing timeout evidence", async () => {
  const report = await runFaultScenario({
    id: "fault-provider-no-timeout",
    kind: "provider_timeout",
    timeoutMs: 50,
    providerLatencyMs: 1,
  });

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "provider_timeout_not_observed"), true);
  assert.equal(report.findings.some((finding) => finding.code === "expected_error_not_observed"), true);
});

test("Given malformed manual cancellation scenario, harness reports unexpected task error", async () => {
  const badDuration = {
    [Symbol.toPrimitive]() {
      throw "invalid-duration";
    },
  };
  const report = await runFaultScenario({
    id: "fault-cancel-malformed",
    kind: "cancellation_storm",
    taskCount: 1,
    cancelAfterMs: badDuration,
    workerDurationMs: 50,
  });

  assert.equal(report.status, "fail");
  assert.equal(report.error.name, "string");
  assert.equal(report.findings.some((finding) => finding.code === "unexpected_error"), true);
});

test("Given truncated retry evidence, harness reports retry mismatch", async () => {
  const report = await runFaultScenario(retryExhaustion({
    attempts: 3,
    initialDelay: 1,
  }), {
    maxEvents: 1,
    receiptId: "fault-retry-truncated",
  });

  assert.equal(report.status, "fail");
  assert.equal(report.findings.some((finding) => finding.code === "retry_exhaustion_not_observed"), true);
});

test("Given invalid fault scenario options, builders reject before execution", () => {
  assert.throws(() => cancellationStorm({ taskCount: 0 }), /taskCount/);
  assert.throws(() => cancellationStorm({ cancelAfter: -1 }), /Invalid duration/);
  assert.throws(() => cleanupHang({ cleanupTimeout: 0 }), /cleanupTimeout/);
  assert.throws(() => providerTimeout({ timeout: 10, providerLatency: 10 }), /providerLatency/);
  assert.throws(() => retryExhaustion({ attempts: 0 }), /attempts/);
});

test("Given the root import, fault harness helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("cancellationStorm" in root, false);
  assert.equal("cleanupHang" in root, false);
  assert.equal("providerTimeout" in root, false);
  assert.equal("retryExhaustion" in root, false);
  assert.equal("runFaultScenario" in root, false);
  assert.equal("runFaultSuite" in root, false);
});
