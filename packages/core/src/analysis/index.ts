/**
 * Analysis helpers for WorkIt receipts and declared event protocols.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This subpath verifies already-declared WorkIt evidence and caller-provided
 * source protocol specifications. It does not parse arbitrary JavaScript source
 * or claim whole-program proofs.
 */

import type { ScopeSnapshot, TaskEvent, TaskSnapshot } from "../types/index.js";
import type { WorkItReceipt, WorkItReceiptEvent } from "../replay/index.js";

/** Analysis result status. */
export type AnalysisStatus = "pass" | "warn" | "fail";

/** Stable finding codes emitted by the analysis subpath. */
export type AnalysisFindingCode =
  | "cleanup_evidence_missing"
  | "cleanup_timeout"
  | "leaked_tasks"
  | "receipt_not_terminal"
  | "receipt_truncated"
  | "source_agent_tool_without_authority"
  | "source_durable_side_effect_without_evidence"
  | "source_parallel_without_bound"
  | "source_protocol_limit_exceeded"
  | "source_resource_without_cleanup"
  | "source_time_policy_unplanned"
  | "task_event_after_terminal"
  | "terminal_cause_missing"
  | "terminal_event_missing"
  | "terminal_failed";

/** Severity assigned to one analysis finding. */
export type AnalysisSeverity = "info" | "warn" | "error";

/** One typed verifier finding. */
export interface AnalysisFinding {
  readonly code: AnalysisFindingCode;
  readonly severity: AnalysisSeverity;
  readonly message: string;
  readonly taskId?: string;
  readonly receiptId?: string;
  readonly moduleId?: string;
  readonly functionId?: string;
  readonly operation?: string;
  readonly count?: number;
  readonly limit?: number;
}

/** Analysis report returned by verifier helpers. */
export interface AnalysisReport {
  readonly status: AnalysisStatus;
  readonly findings: readonly AnalysisFinding[];
}

/** Stable receipt verification checks. */
export type ReceiptVerificationCheckCode =
  | "cleanup_evidence_recorded"
  | "no_orphaned_owned_tasks"
  | "terminal_cause_recorded"
  | "terminal_event_recorded"
  | "terminal_outcome_recorded";

/** One receipt verification check and its local status. */
export interface ReceiptVerificationCheck {
  readonly code: ReceiptVerificationCheckCode;
  readonly status: AnalysisStatus;
  readonly message: string;
  readonly count?: number;
}

/** Options for receipt verification. */
export interface ReceiptVerificationOptions {
  /** Require an observed root scope closing/closed timestamp, not only a closed snapshot. */
  readonly requireTerminalEvent?: boolean;
  /** Require observable cleanup failure/timeout evidence in the receipt. */
  readonly requireCleanupEvidence?: boolean;
}

/** Receipt verification report with explicit checks. */
export interface ReceiptVerificationReport extends AnalysisReport {
  readonly receiptId: string;
  readonly checks: readonly ReceiptVerificationCheck[];
}

/** Bounded source protocol operation understood by `verifySourceProtocol`. */
export type SourceProtocolOperation =
  | "activity.run"
  | "agent.tool"
  | "authority.check"
  | "channel.backpressure"
  | "ctx.defer"
  | "durable.side_effect"
  | "promise.all"
  | "receipt.append"
  | "resource.acquire"
  | "resource.bracketLazy"
  | "resource.bracketShared"
  | "run.bracket"
  | "run.hedge"
  | "run.pool"
  | "run.retry"
  | "run.timeout"
  | "scope.acquire"
  | "scope.spawn"
  | "time_policy.plan"
  | "work.parallel";

/** Function class used by source protocol analysis. */
export type SourceProtocolFunctionKind =
  | "activity"
  | "agent_tool"
  | "handler"
  | "resource"
  | "task";

/** One operation observed or declared inside a function body. */
export interface SourceProtocolUse {
  readonly operation: SourceProtocolOperation;
  readonly target?: string;
  readonly capability?: string;
  readonly line?: number;
}

/** One function-level source protocol contract. */
export interface SourceProtocolFunction {
  readonly functionId: string;
  readonly kind?: SourceProtocolFunctionKind;
  readonly uses: readonly SourceProtocolUse[];
}

/** One module-level source protocol contract. */
export interface SourceProtocolModule {
  readonly moduleId: string;
  readonly functions: readonly SourceProtocolFunction[];
}

/** Bounded source protocol specification supplied by the caller. */
export interface SourceProtocolSpec {
  readonly version?: "workit.source-protocol.v1";
  readonly modules: readonly SourceProtocolModule[];
}

/** Options that keep source protocol analysis bounded. */
export interface SourceProtocolAnalysisOptions {
  readonly maxModules?: number;
  readonly maxFunctions?: number;
  readonly maxUsesPerFunction?: number;
}

/** Source protocol report with checked-count evidence. */
export interface SourceProtocolAnalysisReport extends AnalysisReport {
  readonly checkedModules: number;
  readonly checkedFunctions: number;
  readonly checkedUses: number;
}

const DEFAULT_SOURCE_PROTOCOL_LIMITS = {
  maxModules: 100,
  maxFunctions: 1_000,
  maxUsesPerFunction: 100,
} as const;

/** Verifies lifecycle invariants visible in one replay receipt. */
export function analyzeReceipt(receipt: WorkItReceipt): AnalysisReport {
  const verified = verifyReceipt(receipt);
  return {
    status: verified.status,
    findings: verified.findings,
  };
}

/** Verifies explicit lifecycle evidence already present in a WorkIt receipt. */
export function verifyReceipt(
  receipt: WorkItReceipt,
  opts: ReceiptVerificationOptions = {},
): ReceiptVerificationReport {
  const findings: AnalysisFinding[] = [];
  const checks: ReceiptVerificationCheck[] = [];
  const pendingTasks = collectPendingTasks(receipt.snapshot);
  const leakedTaskCount = Math.max(pendingTasks.length, receipt.summary.leakedTasks);
  const cleanupEvidenceCount = receipt.summary.cleanupFailures + receipt.summary.cleanupTimeouts;
  const terminalEventRecorded = receipt.terminal.at !== undefined
    || receipt.events.some((event) =>
      event.scopeId === receipt.rootScopeId
      && (event.type === "scope:closing" || event.type === "scope:closed")
    );

  if (receipt.terminal.outcome === "running") {
    findings.push({
      code: "receipt_not_terminal",
      severity: "error",
      message: "receipt does not contain a terminal scope outcome",
      receiptId: receipt.receiptId,
    });
  }
  checks.push({
    code: "terminal_outcome_recorded",
    status: receipt.terminal.outcome === "running" ? "fail" : "pass",
    message: receipt.terminal.outcome === "running"
      ? "receipt does not contain a terminal scope outcome"
      : "receipt contains a terminal scope outcome",
  });

  if (leakedTaskCount > 0) {
    const firstPending = pendingTasks[0];
    findings.push({
      code: "leaked_tasks",
      severity: "error",
      message: "receipt snapshot contains pending owned tasks",
      receiptId: receipt.receiptId,
      ...(firstPending !== undefined ? { taskId: firstPending.id } : {}),
    });
  }
  checks.push({
    code: "no_orphaned_owned_tasks",
    status: leakedTaskCount > 0 ? "fail" : "pass",
    message: leakedTaskCount > 0
      ? "receipt snapshot contains pending owned tasks"
      : "receipt snapshot contains no pending owned tasks",
    count: leakedTaskCount,
  });

  if (receipt.summary.cleanupTimeouts > 0) {
    findings.push({
      code: "cleanup_timeout",
      severity: "warn",
      message: "receipt contains bounded cleanup timeout evidence",
      receiptId: receipt.receiptId,
    });
  }
  if (opts.requireCleanupEvidence === true && cleanupEvidenceCount === 0) {
    findings.push({
      code: "cleanup_evidence_missing",
      severity: "error",
      message: "receipt does not contain observable cleanup failure or timeout evidence",
      receiptId: receipt.receiptId,
    });
  }
  checks.push({
    code: "cleanup_evidence_recorded",
    status: opts.requireCleanupEvidence === true && cleanupEvidenceCount === 0 ? "fail" : "pass",
    message: cleanupEvidenceCount > 0
      ? "receipt contains observable cleanup failure or timeout evidence"
      : "receipt has no observable cleanup failure or timeout evidence",
    count: cleanupEvidenceCount,
  });

  if (receipt.summary.droppedEvents > 0) {
    findings.push({
      code: "receipt_truncated",
      severity: "warn",
      message: "receipt event window was truncated before analysis",
      receiptId: receipt.receiptId,
    });
  }

  const terminalCauseRequired = requiresTerminalCause(receipt);
  const terminalCausePresent = hasTerminalCause(receipt);
  const terminalCauseRecorded = !terminalCauseRequired || terminalCausePresent;

  if (!terminalCauseRecorded) {
    findings.push({
      code: "terminal_cause_missing",
      severity: "error",
      message: "failed or cancelled receipt does not include terminal cause evidence",
      receiptId: receipt.receiptId,
    });
  }
  checks.push({
    code: "terminal_cause_recorded",
    status: terminalCauseRecorded ? "pass" : "fail",
    message: terminalCauseRecorded
      ? "receipt terminal cause evidence is present or not required for this outcome"
      : "failed or cancelled receipt does not include terminal cause evidence",
  });

  if (opts.requireTerminalEvent === true && !terminalEventRecorded) {
    findings.push({
      code: "terminal_event_missing",
      severity: "error",
      message: "receipt does not contain root scope terminal event evidence",
      receiptId: receipt.receiptId,
    });
  }
  checks.push({
    code: "terminal_event_recorded",
    status: opts.requireTerminalEvent === true && !terminalEventRecorded ? "fail" : "pass",
    message: terminalEventRecorded
      ? "receipt contains root scope terminal event evidence"
      : "receipt terminal event evidence was not required for this verification",
  });

  if (receipt.terminal.outcome === "failed") {
    findings.push({
      code: "terminal_failed",
      severity: "error",
      message: "receipt terminal outcome is failed",
      receiptId: receipt.receiptId,
    });
  }

  return {
    ...report(findings),
    receiptId: receipt.receiptId,
    checks,
  };
}

/** Verifies a caller-provided source protocol contract for ownership gaps. */
export function verifySourceProtocol(
  spec: SourceProtocolSpec,
  opts: SourceProtocolAnalysisOptions = {},
): SourceProtocolAnalysisReport {
  const limits = normalizeSourceProtocolLimits(opts);
  const findings: AnalysisFinding[] = [];
  let checkedModules = 0;
  let checkedFunctions = 0;
  let checkedUses = 0;

  if (spec.modules.length > limits.maxModules) {
    findings.push(limitFinding(
      "source protocol module count exceeds configured analysis bound",
      spec.modules.length,
      limits.maxModules,
    ));
  }

  for (const module of spec.modules.slice(0, limits.maxModules)) {
    checkedModules++;
    if (checkedFunctions + module.functions.length > limits.maxFunctions) {
      findings.push(limitFinding(
        "source protocol function count exceeds configured analysis bound",
        checkedFunctions + module.functions.length,
        limits.maxFunctions,
      ));
    }

    const remainingFunctions = Math.max(0, limits.maxFunctions - checkedFunctions);
    for (const fn of module.functions.slice(0, remainingFunctions)) {
      checkedFunctions++;
      const uses = fn.uses.slice(0, limits.maxUsesPerFunction);
      checkedUses += uses.length;

      if (fn.uses.length > limits.maxUsesPerFunction) {
        findings.push({
          code: "source_protocol_limit_exceeded",
          severity: "error",
          message: "source protocol function use count exceeds configured analysis bound",
          moduleId: module.moduleId,
          functionId: fn.functionId,
          count: fn.uses.length,
          limit: limits.maxUsesPerFunction,
        });
      }

      findings.push(...analyzeSourceFunction(module, fn, uses));
    }
  }

  return {
    ...report(findings),
    checkedModules,
    checkedFunctions,
    checkedUses,
  };
}

/** Verifies basic lifecycle ordering over WorkIt task events. */
export function verifyScopeProtocol(events: readonly (TaskEvent | WorkItReceiptEvent)[]): AnalysisReport {
  const findings: AnalysisFinding[] = [];
  const terminalTasks = new Set<string>();

  for (const event of events) {
    if (!isTaskEvent(event)) continue;
    if (terminalTasks.has(event.taskId)) {
      findings.push({
        code: "task_event_after_terminal",
        severity: "error",
        message: "task emitted an event after its terminal lifecycle event",
        taskId: event.taskId,
      });
      continue;
    }

    if (isTaskTerminal(event.type)) terminalTasks.add(event.taskId);
  }

  return report(findings);
}

function report(findings: readonly AnalysisFinding[]): AnalysisReport {
  const hasError = findings.some((finding) => finding.severity === "error");
  const hasWarning = findings.some((finding) => finding.severity === "warn");
  return {
    status: hasError ? "fail" : hasWarning ? "warn" : "pass",
    findings,
  };
}

function isTaskEvent(event: TaskEvent | WorkItReceiptEvent): event is (TaskEvent | WorkItReceiptEvent) & { taskId: string } {
  return typeof (event as { taskId?: unknown }).taskId === "string";
}

function isTaskTerminal(type: TaskEvent["type"] | WorkItReceiptEvent["type"]): boolean {
  return type === "task:succeeded" || type === "task:failed" || type === "task:cancelled";
}

function normalizeSourceProtocolLimits(opts: SourceProtocolAnalysisOptions): Required<SourceProtocolAnalysisOptions> {
  const limits = {
    maxModules: opts.maxModules ?? DEFAULT_SOURCE_PROTOCOL_LIMITS.maxModules,
    maxFunctions: opts.maxFunctions ?? DEFAULT_SOURCE_PROTOCOL_LIMITS.maxFunctions,
    maxUsesPerFunction: opts.maxUsesPerFunction ?? DEFAULT_SOURCE_PROTOCOL_LIMITS.maxUsesPerFunction,
  };

  assertPositiveInteger("maxModules", limits.maxModules);
  assertPositiveInteger("maxFunctions", limits.maxFunctions);
  assertPositiveInteger("maxUsesPerFunction", limits.maxUsesPerFunction);
  return limits;
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

function analyzeSourceFunction(
  module: SourceProtocolModule,
  fn: SourceProtocolFunction,
  uses: readonly SourceProtocolUse[],
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const operations = new Set(uses.map((use) => use.operation));

  if (operations.has("resource.acquire") && !hasAny(operations, [
    "ctx.defer",
    "resource.bracketLazy",
    "resource.bracketShared",
    "run.bracket",
    "scope.acquire",
  ])) {
    findings.push(sourceFinding(
      "source_resource_without_cleanup",
      "resource acquisition is not paired with a WorkIt cleanup owner",
      module.moduleId,
      fn.functionId,
      "resource.acquire",
    ));
  }

  if (operations.has("durable.side_effect") && !hasAny(operations, ["activity.run", "receipt.append"])) {
    findings.push(sourceFinding(
      "source_durable_side_effect_without_evidence",
      "durable side effect is not guarded by an activity boundary or receipt append",
      module.moduleId,
      fn.functionId,
      "durable.side_effect",
    ));
  }

  if (operations.has("promise.all") && !hasAny(operations, [
    "channel.backpressure",
    "run.pool",
    "scope.spawn",
    "work.parallel",
  ])) {
    findings.push(sourceFinding(
      "source_parallel_without_bound",
      "parallel fan-out is not paired with a WorkIt concurrency or backpressure owner",
      module.moduleId,
      fn.functionId,
      "promise.all",
    ));
  }

  if (hasAny(operations, ["run.hedge", "run.retry", "run.timeout"]) && !operations.has("time_policy.plan")) {
    findings.push(sourceFinding(
      "source_time_policy_unplanned",
      "runtime time policy is not paired with declared time-policy planning",
      module.moduleId,
      fn.functionId,
      "time_policy.plan",
    ));
  }

  if (
    fn.kind === "agent_tool"
    && operations.has("durable.side_effect")
    && !hasDeclaredAuthority(uses)
  ) {
    findings.push(sourceFinding(
      "source_agent_tool_without_authority",
      "agent tool side effect is not paired with declared capability authority",
      module.moduleId,
      fn.functionId,
      "authority.check",
    ));
  }

  return findings;
}

function hasAny(operations: ReadonlySet<SourceProtocolOperation>, expected: readonly SourceProtocolOperation[]): boolean {
  return expected.some((operation) => operations.has(operation));
}

function hasDeclaredAuthority(uses: readonly SourceProtocolUse[]): boolean {
  return uses.some((use) =>
    (use.operation === "authority.check" || use.operation === "agent.tool")
    && typeof use.capability === "string"
    && use.capability.length > 0
  );
}

function sourceFinding(
  code: AnalysisFindingCode,
  message: string,
  moduleId: string,
  functionId: string,
  operation: SourceProtocolOperation,
): AnalysisFinding {
  return {
    code,
    severity: "error",
    message,
    moduleId,
    functionId,
    operation,
  };
}

function limitFinding(message: string, actual: number, limit: number): AnalysisFinding {
  return {
    code: "source_protocol_limit_exceeded",
    severity: "error",
    message,
    count: actual,
    limit,
  };
}

function collectPendingTasks(snapshot: ScopeSnapshot): TaskSnapshot[] {
  const childTasks = snapshot.scopes.flatMap(collectPendingTasks);
  return [
    ...snapshot.tasks.filter((task) => task.status === "pending" || task.status === "running"),
    ...childTasks,
  ];
}

function hasTerminalCause(receipt: WorkItReceipt): boolean {
  switch (receipt.terminal.outcome) {
    case "failed":
      return receipt.terminal.error !== undefined;
    case "cancelled":
      return receipt.terminal.cancelReason !== undefined;
    case "completed":
    case "running":
      return true;
  }
}

function requiresTerminalCause(receipt: WorkItReceipt): boolean {
  switch (receipt.terminal.outcome) {
    case "failed":
    case "cancelled":
      return true;
    case "completed":
    case "running":
      return false;
  }
}
