/**
 * Fault-injection harness for WorkIt lifecycle evidence.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The harness runs explicit, bounded failure scenarios through the real WorkIt
 * scope engine and returns receipts plus verifier reports. It is evidence
 * infrastructure, not a scheduler replay engine or process supervisor.
 */

import { getCurrentScope, group, type TaskSpawner } from "../engine/scope.js";
import { parseDuration } from "../engine/duration.js";
import { run } from "../run/index.js";
import { type Duration, type Scope } from "../types/index.js";
import {
  createReceiptRecorder,
  type ReceiptRecorder,
  type WorkItReceipt,
  type WorkItReceiptEvent,
} from "../replay/index.js";
import { analyzeReceipt, verifyScopeProtocol, type AnalysisReport } from "../analysis/index.js";

/** Built-in fault scenarios supported by the harness. */
export type FaultScenarioKind =
  | "cancellation_storm"
  | "cleanup_hang"
  | "provider_timeout"
  | "retry_exhaustion";

/** Scenario that cancels many owned child tasks under one scope. */
export interface CancellationStormScenario {
  readonly id: string;
  readonly kind: "cancellation_storm";
  readonly taskCount: number;
  readonly cancelAfterMs: number;
  readonly workerDurationMs: number;
}

/** Scenario that registers a cleanup handler which does not settle before its timeout. */
export interface CleanupHangScenario {
  readonly id: string;
  readonly kind: "cleanup_hang";
  readonly cleanupTimeoutMs: number;
}

/** Scenario that drives a provider-like task through WorkIt's timeout wrapper. */
export interface ProviderTimeoutScenario {
  readonly id: string;
  readonly kind: "provider_timeout";
  readonly timeoutMs: number;
  readonly providerLatencyMs: number;
}

/** Scenario that exhausts WorkIt's retry wrapper with a deterministic failing task. */
export interface RetryExhaustionScenario {
  readonly id: string;
  readonly kind: "retry_exhaustion";
  readonly attempts: number;
  readonly initialDelayMs: number;
}

/** Built-in fault scenario definition. */
export type FaultScenario =
  | CancellationStormScenario
  | CleanupHangScenario
  | ProviderTimeoutScenario
  | RetryExhaustionScenario;

/** Options for creating a cancellation storm scenario. */
export interface CancellationStormOptions {
  readonly id?: string;
  readonly taskCount?: number;
  readonly cancelAfter?: Duration;
  readonly workerDuration?: Duration;
}

/** Options for creating a cleanup hang scenario. */
export interface CleanupHangOptions {
  readonly id?: string;
  readonly cleanupTimeout?: Duration;
}

/** Options for creating a provider timeout scenario. */
export interface ProviderTimeoutOptions {
  readonly id?: string;
  readonly timeout?: Duration;
  readonly providerLatency?: Duration;
}

/** Options for creating a retry exhaustion scenario. */
export interface RetryExhaustionOptions {
  readonly id?: string;
  readonly attempts?: number;
  readonly initialDelay?: Duration;
}

/** Harness execution options. */
export interface FaultRunOptions {
  readonly receiptId?: string;
  readonly clock?: () => number;
  readonly maxEvents?: number;
}

/** Safe error evidence included in fault reports. */
export interface FaultErrorEvidence {
  readonly name: string;
  readonly message: string;
}

/** Typed observation emitted by the fault harness itself. */
export interface FaultObservation {
  readonly type: "fault:injected" | "fault:observed";
  readonly scenarioId: string;
  readonly kind: FaultScenarioKind;
  readonly at: number;
  readonly message: string;
  readonly count?: number;
  readonly durationMs?: number;
  readonly attempts?: number;
  readonly error?: FaultErrorEvidence;
}

/** Stable finding codes returned by fault reports. */
export type FaultFindingCode =
  | "cleanup_timeout_not_observed"
  | "expected_cancellation_not_observed"
  | "expected_error_not_observed"
  | "leaked_tasks"
  | "protocol_violation"
  | "provider_timeout_not_observed"
  | "receipt_not_terminal"
  | "retry_exhaustion_not_observed"
  | "unexpected_error";

/** One finding emitted by the harness verifier. */
export interface FaultFinding {
  readonly code: FaultFindingCode;
  readonly severity: "error";
  readonly message: string;
  readonly expected?: number | string;
  readonly actual?: number | string;
}

/** Report returned for one fault scenario run. */
export interface FaultReport {
  readonly scenario: FaultScenario;
  readonly status: "pass" | "fail";
  readonly durationMs: number;
  readonly receipt: WorkItReceipt;
  readonly analysis: AnalysisReport;
  readonly protocol: AnalysisReport;
  readonly observations: readonly FaultObservation[];
  readonly findings: readonly FaultFinding[];
  readonly error?: FaultErrorEvidence;
}

/** Aggregate report returned for a fault suite. */
export interface FaultSuiteReport {
  readonly reports: readonly FaultReport[];
  readonly passed: number;
  readonly failed: number;
}

interface FaultExecutionContext {
  readonly task: TaskSpawner;
  readonly scope: Scope;
  observe(observation: Omit<FaultObservation, "scenarioId" | "kind" | "at">): void;
}

const DEFAULT_CANCEL_STORM_TASKS = 8;
const DEFAULT_CANCEL_AFTER_MS = 1;
const DEFAULT_WORKER_DURATION_MS = 1_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5;
const DEFAULT_PROVIDER_LATENCY_MS = 50;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1;
const MAX_FAULT_TASKS = 1_000;
const MAX_FAULT_ATTEMPTS = 1_000;

/** Creates a bounded cancellation-storm scenario. */
export function cancellationStorm(opts: CancellationStormOptions = {}): CancellationStormScenario {
  const taskCount = opts.taskCount ?? DEFAULT_CANCEL_STORM_TASKS;
  assertPositiveInteger("taskCount", taskCount, MAX_FAULT_TASKS);
  const cancelAfterMs = parseNonNegativeDuration(opts.cancelAfter ?? DEFAULT_CANCEL_AFTER_MS, "cancelAfter");
  const workerDurationMs = parsePositiveDuration(opts.workerDuration ?? DEFAULT_WORKER_DURATION_MS, "workerDuration");
  return {
    id: opts.id ?? "fault:cancellation-storm",
    kind: "cancellation_storm",
    taskCount,
    cancelAfterMs,
    workerDurationMs,
  };
}

/** Creates a cleanup-timeout scenario. */
export function cleanupHang(opts: CleanupHangOptions = {}): CleanupHangScenario {
  return {
    id: opts.id ?? "fault:cleanup-hang",
    kind: "cleanup_hang",
    cleanupTimeoutMs: parsePositiveDuration(opts.cleanupTimeout ?? DEFAULT_CLEANUP_TIMEOUT_MS, "cleanupTimeout"),
  };
}

/** Creates a provider timeout scenario. */
export function providerTimeout(opts: ProviderTimeoutOptions = {}): ProviderTimeoutScenario {
  const timeoutMs = parsePositiveDuration(opts.timeout ?? DEFAULT_PROVIDER_TIMEOUT_MS, "timeout");
  const providerLatencyMs = parsePositiveDuration(opts.providerLatency ?? DEFAULT_PROVIDER_LATENCY_MS, "providerLatency");
  if (providerLatencyMs <= timeoutMs) {
    throw new RangeError("providerLatency must be greater than timeout for provider_timeout evidence");
  }
  return {
    id: opts.id ?? "fault:provider-timeout",
    kind: "provider_timeout",
    timeoutMs,
    providerLatencyMs,
  };
}

/** Creates a retry-exhaustion scenario. */
export function retryExhaustion(opts: RetryExhaustionOptions = {}): RetryExhaustionScenario {
  const attempts = opts.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  assertPositiveInteger("attempts", attempts, MAX_FAULT_ATTEMPTS);
  return {
    id: opts.id ?? "fault:retry-exhaustion",
    kind: "retry_exhaustion",
    attempts,
    initialDelayMs: parseNonNegativeDuration(opts.initialDelay ?? DEFAULT_RETRY_DELAY_MS, "initialDelay"),
  };
}

/** Runs one fault scenario through the real WorkIt scope engine and returns executable evidence. */
export async function runFaultScenario(
  scenario: FaultScenario,
  opts: FaultRunOptions = {},
): Promise<FaultReport> {
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const observations: FaultObservation[] = [];
  let scope: Scope | undefined;
  let recorder: ReceiptRecorder | undefined;
  let error: unknown;

  const observe = (observation: Omit<FaultObservation, "scenarioId" | "kind" | "at">): void => {
    observations.push({
      scenarioId: scenario.id,
      kind: scenario.kind,
      at: clock(),
      ...observation,
    });
  };

  try {
    const cleanupTimeout = cleanupTimeoutFor(scenario);
    await group(async (task) => {
      const current = getCurrentScope();
      /* v8 ignore next -- group() binds the current scope before invoking its body. */
      if (current === null) throw new Error("fault harness requires an active WorkIt scope");
      scope = current;
      recorder = createReceiptRecorder(current, {
        clock,
        receiptId: opts.receiptId ?? `fault:${scenario.id}`,
        ...(opts.maxEvents !== undefined ? { maxEvents: opts.maxEvents } : {}),
      });
      await executeScenario(scenario, { task, scope: current, observe });
    }, {
      name: scenario.id,
      ...(cleanupTimeout !== undefined ? { cleanupTimeout } : {}),
    });
  } catch (err) {
    error = err;
    observe({
      type: "fault:observed",
      message: "scenario execution threw",
      error: normalizeError(err),
    });
  }

  /* v8 ignore next -- the recorder is initialized before any scenario executes inside group(). */
  if (scope === undefined || recorder === undefined) {
    throw new Error("fault harness did not initialize a WorkIt scope");
  }

  const receipt = recorder.build(scope.status(), {
    clock,
    receiptId: opts.receiptId ?? `fault:${scenario.id}`,
    limitations: ["fault_injection_is_bounded_runtime_evidence_not_deterministic_replay"],
  });
  recorder.unsubscribe();

  const analysis = analyzeReceipt(receipt);
  const protocol = verifyScopeProtocol(receipt.events);
  const findings = verifyScenario(scenario, receipt, analysis, protocol, error);
  return {
    scenario,
    status: findings.length === 0 ? "pass" : "fail",
    durationMs: Math.max(0, clock() - startedAt),
    receipt,
    analysis,
    protocol,
    observations,
    findings,
    ...(error !== undefined ? { error: normalizeError(error) } : {}),
  };
}

/** Runs scenarios in order and returns aggregate pass/fail counts. */
export async function runFaultSuite(
  scenarios: readonly FaultScenario[],
  opts: FaultRunOptions = {},
): Promise<FaultSuiteReport> {
  const reports: FaultReport[] = [];
  for (const scenario of scenarios) reports.push(await runFaultScenario(scenario, opts));
  const passed = reports.filter((report) => report.status === "pass").length;
  return {
    reports,
    passed,
    failed: reports.length - passed,
  };
}

async function executeScenario(scenario: FaultScenario, ctx: FaultExecutionContext): Promise<void> {
  switch (scenario.kind) {
    case "cancellation_storm":
      return executeCancellationStorm(scenario, ctx);
    case "cleanup_hang":
      return executeCleanupHang(scenario, ctx);
    case "provider_timeout":
      return executeProviderTimeout(scenario, ctx);
    case "retry_exhaustion":
      return executeRetryExhaustion(scenario, ctx);
  }
}

async function executeCancellationStorm(
  scenario: CancellationStormScenario,
  ctx: FaultExecutionContext,
): Promise<void> {
  const handles = Array.from({ length: scenario.taskCount }, () =>
    ctx.task(async (taskCtx) => {
      await sleep(scenario.workerDurationMs, taskCtx.signal);
    }, { name: "fault.cancellation.worker", kind: "io" }));

  await sleep(scenario.cancelAfterMs);
  ctx.observe({
    type: "fault:injected",
    message: "scope cancellation requested",
    count: scenario.taskCount,
  });
  ctx.scope.cancel({ kind: "manual", tag: "fault_cancellation_storm" });
  await Promise.allSettled(handles);
}

async function executeCleanupHang(scenario: CleanupHangScenario, ctx: FaultExecutionContext): Promise<void> {
  await ctx.task(async (taskCtx) => {
    taskCtx.defer(() => new Promise(() => undefined), { timeout: scenario.cleanupTimeoutMs });
    ctx.observe({
      type: "fault:injected",
      message: "non-settling cleanup registered",
      durationMs: scenario.cleanupTimeoutMs,
    });
  }, { name: "fault.cleanup.hang", kind: "io", cleanupTimeout: scenario.cleanupTimeoutMs });
}

async function executeProviderTimeout(scenario: ProviderTimeoutScenario, ctx: FaultExecutionContext): Promise<void> {
  ctx.observe({
    type: "fault:injected",
    message: "provider latency exceeds timeout",
    durationMs: scenario.providerLatencyMs,
  });
  await ctx.task(run.timeout(async (taskCtx) => {
    await sleep(scenario.providerLatencyMs, taskCtx.signal);
  }, scenario.timeoutMs), { name: "fault.provider.timeout", kind: "llm" });
}

async function executeRetryExhaustion(scenario: RetryExhaustionScenario, ctx: FaultExecutionContext): Promise<void> {
  ctx.observe({
    type: "fault:injected",
    message: "retrying task will fail every attempt",
    attempts: scenario.attempts,
  });
  await ctx.task(run.retry(async () => {
    throw new Error("fault_retry_exhausted");
  }, {
    times: scenario.attempts,
    initialDelay: scenario.initialDelayMs,
    maxDelay: scenario.initialDelayMs,
    jitter: false,
  }), { name: "fault.retry.exhaustion", kind: "io" });
}

function verifyScenario(
  scenario: FaultScenario,
  receipt: WorkItReceipt,
  analysis: AnalysisReport,
  protocol: AnalysisReport,
  error: unknown,
): FaultFinding[] {
  const findings: FaultFinding[] = [];
  const leaked = analysis.findings.find((finding) => finding.code === "leaked_tasks");
  const notTerminal = analysis.findings.find((finding) => finding.code === "receipt_not_terminal");
  /* v8 ignore next -- reports are built after WorkIt closes the observed scope. */
  if (leaked !== undefined) {
    findings.push({
      code: "leaked_tasks",
      severity: "error",
      message: leaked.message,
    });
  }
  /* v8 ignore next -- reports are built after WorkIt emits terminal scope evidence. */
  if (notTerminal !== undefined) {
    findings.push({
      code: "receipt_not_terminal",
      severity: "error",
      message: notTerminal.message,
    });
  }
  /* v8 ignore next -- protocol input comes from WorkIt's typed event stream. */
  if (protocol.status === "fail") {
    findings.push({
      code: "protocol_violation",
      severity: "error",
      message: "receipt event stream violates the WorkIt task protocol",
    });
  }

  switch (scenario.kind) {
    case "cancellation_storm":
      verifyCancellationStorm(scenario, receipt, error, findings);
      break;
    case "cleanup_hang":
      verifyCleanupHang(receipt, error, findings);
      break;
    case "provider_timeout":
      verifyProviderTimeout(receipt, error, findings);
      break;
    case "retry_exhaustion":
      verifyRetryExhaustion(scenario, receipt, error, findings);
      break;
  }

  return findings;
}

function verifyCancellationStorm(
  scenario: CancellationStormScenario,
  receipt: WorkItReceipt,
  error: unknown,
  findings: FaultFinding[],
): void {
  const cancelled = countEvents(receipt.events, (event) => event.type === "task:cancelled");
  if (cancelled < scenario.taskCount) {
    findings.push({
      code: "expected_cancellation_not_observed",
      severity: "error",
      message: "not every storm worker emitted task cancellation evidence",
      expected: scenario.taskCount,
      actual: cancelled,
    });
  }
  if (receipt.terminal.outcome !== "cancelled") {
    findings.push({
      code: "expected_cancellation_not_observed",
      severity: "error",
      message: "scope terminal outcome was not cancelled",
      expected: "cancelled",
      actual: receipt.terminal.outcome,
    });
  }
  /* v8 ignore next -- cancellation storm settles through child cancellation evidence. */
  if (error !== undefined) pushUnexpectedError(findings, error);
}

function verifyCleanupHang(receipt: WorkItReceipt, error: unknown, findings: FaultFinding[]): void {
  const cleanupTimeouts = countEvents(receipt.events, (event) =>
    event.type === "task:cleanup_timeout" || event.type === "scope:cleanup_timeout");
  if (cleanupTimeouts < 1) {
    findings.push({
      code: "cleanup_timeout_not_observed",
      severity: "error",
      message: "cleanup timeout evidence was not emitted",
      expected: 1,
      actual: cleanupTimeouts,
    });
  }
  /* v8 ignore next -- cleanup timeout scenarios complete through cleanup evidence. */
  if (error !== undefined) pushUnexpectedError(findings, error);
}

function verifyProviderTimeout(receipt: WorkItReceipt, error: unknown, findings: FaultFinding[]): void {
  const timeoutFailures = countEvents(receipt.events, (event) =>
    event.type === "task:failed" && event.error?.name === "TimeoutError");
  if (timeoutFailures < 1) {
    findings.push({
      code: "provider_timeout_not_observed",
      severity: "error",
      message: "timeout wrapper did not emit task failure evidence",
      expected: 1,
      actual: timeoutFailures,
    });
  }
  if (error === undefined) pushExpectedErrorMissing(findings);
}

function verifyRetryExhaustion(
  scenario: RetryExhaustionScenario,
  receipt: WorkItReceipt,
  error: unknown,
  findings: FaultFinding[],
): void {
  const retryEvents = countEvents(receipt.events, (event) => event.type === "task:retrying");
  const expectedRetries = scenario.attempts - 1;
  if (retryEvents !== expectedRetries) {
    findings.push({
      code: "retry_exhaustion_not_observed",
      severity: "error",
      message: "retry exhaustion evidence did not match configured attempts",
      expected: expectedRetries,
      actual: retryEvents,
    });
  }
  /* v8 ignore next -- retry exhaustion uses a task body that always throws. */
  if (error === undefined) pushExpectedErrorMissing(findings);
}

function countEvents(
  events: readonly WorkItReceiptEvent[],
  predicate: (event: WorkItReceiptEvent) => boolean,
): number {
  return events.filter(predicate).length;
}

function cleanupTimeoutFor(scenario: FaultScenario): Duration | undefined {
  return scenario.kind === "cleanup_hang" ? scenario.cleanupTimeoutMs : undefined;
}

function pushUnexpectedError(findings: FaultFinding[], error: unknown): void {
  findings.push({
    code: "unexpected_error",
    severity: "error",
    message: "scenario threw although the injected behavior should settle through scope evidence",
    actual: normalizeError(error).name,
  });
}

function pushExpectedErrorMissing(findings: FaultFinding[]): void {
  findings.push({
    code: "expected_error_not_observed",
    severity: "error",
    message: "scenario did not throw although the injected behavior should fail the owned task",
  });
}

function normalizeError(error: unknown): FaultErrorEvidence {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: typeof error, message: String(error) };
}

function parsePositiveDuration(value: Duration, field: string): number {
  const ms = parseDuration(value);
  if (ms <= 0) throw new RangeError(`${field} must be greater than 0ms`);
  return ms;
}

function parseNonNegativeDuration(value: Duration, field: string): number {
  void field;
  const ms = parseDuration(value);
  return ms;
}

function assertPositiveInteger(field: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${field} must be an integer between 1 and ${max}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  /* v8 ignore next -- built-in scenarios pass live signals before cancellation is injected. */
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
