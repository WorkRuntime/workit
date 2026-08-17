/**
 * Deterministic candidate selection with typed failure and quality policy.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Candidate execution is sequential and may repeat side effects. Callers own
 * idempotency for side-effecting operations.
 */

import { createAttemptRecorder } from "../replay/index.js";
import { run } from "../run/index.js";
import { validateRetryPolicy } from "../engine/retry.js";
import type { RetryOpts, TaskFn } from "../types/index.js";
import {
  CandidateCallbackError,
  ClassifiedCandidateError,
  classifyCandidateError,
  classifyWorkItFailure as classifyKnownWorkItFailure,
  normalizeAcceptanceDecision,
} from "./classification.js";
import {
  mapCandidateEvidence,
  type CandidateDecisionRecord,
} from "./evidence.js";
import type {
  CandidateActionDecision,
  CandidateFailureDecision,
  CandidateRetryPolicy,
  CandidateRunResult,
  FirstAcceptableOptions,
} from "./types.js";

export type {
  AcceptanceDecision,
  CandidateActionDecision,
  CandidateAttemptDecision,
  CandidateAttemptEvidence,
  CandidateFailureDecision,
  CandidateRetryPolicy,
  CandidateRunResult,
  FailureDisposition,
  FirstAcceptableOptions,
} from "./types.js";

const DEFAULT_MAX_CANDIDATES = 16;
const MAX_CANDIDATES = 1_000;
const DEFAULT_MAX_EVIDENCE = 256;
const DEFAULT_RETRY_POLICY: CandidateRetryPolicy = Object.freeze({ times: 1 });
const MAX_TOTAL_CANDIDATE_ATTEMPTS = 10_000;
const CANDIDATE_TASK_NAME = "candidate";

/** Returns the safe built-in classification for a known WorkIt runtime error. */
export function classifyWorkItFailure(error: unknown): CandidateFailureDecision | undefined {
  return classifyKnownWorkItFailure(error);
}

type AttemptResult<T> =
  | { readonly accepted: true; readonly value: T }
  | { readonly accepted: false };

interface CandidatePolicy<C, T> {
  readonly execute: FirstAcceptableOptions<C, T>["execute"];
  readonly accept: FirstAcceptableOptions<C, T>["accept"];
  readonly classifyFailure: FirstAcceptableOptions<C, T>["classifyFailure"];
  readonly retry: RetryOpts;
  readonly deadlineAt?: number;
  readonly candidateMetadata?: FirstAcceptableOptions<C, T>["candidateMetadata"];
}

interface CandidateDecisionBuffer {
  readonly records: CandidateDecisionRecord[];
  readonly limit: number;
}

/** Selects the first semantically acceptable result in deterministic candidate order. */
export async function firstAcceptable<C, T>(
  candidates: readonly C[],
  opts: FirstAcceptableOptions<C, T>,
): Promise<CandidateRunResult<C, T>> {
  const admittedCandidates = snapshotCandidates(candidates);
  const policy = normalizeCandidatePolicy(admittedCandidates, opts);
  const evidenceOptions = opts.evidence;
  const evidenceLimit = evidenceOptions?.maxAttempts ?? DEFAULT_MAX_EVIDENCE;
  const recorder = createAttemptRecorder({
    ...evidenceOptions,
    maxAttempts: evidenceLimit,
  });
  const decisions: CandidateDecisionBuffer = { records: [], limit: evidenceLimit };

  for (let candidateIndex = 0; candidateIndex < admittedCandidates.length; candidateIndex++) {
    const candidate = admittedCandidates[candidateIndex]!;
    const task = buildCandidateTask(candidate, candidateIndex, policy, recorder, decisions);
    try {
      const attemptResult = await run.group(async (spawn) => spawn(task, { name: CANDIDATE_TASK_NAME }));
      if (!attemptResult.accepted) continue;
      return {
        status: "accepted",
        candidate,
        candidateIndex,
        value: attemptResult.value,
        ...readEvidence(recorder, decisions.records),
      };
    } catch (error) {
      if (!(error instanceof ClassifiedCandidateError)) throw unwrapCallbackError(error);
      const result = resultFromFailure<C, T>(error, recorder, decisions.records);
      if (result !== undefined) return result;
    }
  }

  return {
    status: "exhausted",
    ...readEvidence(recorder, decisions.records),
  };
}

function buildCandidateTask<C, T>(
  candidate: C,
  candidateIndex: number,
  policy: CandidatePolicy<C, T>,
  recorder: ReturnType<typeof createAttemptRecorder>,
  decisions: CandidateDecisionBuffer,
): TaskFn<AttemptResult<T>> {
  const candidateMetadata = policy.candidateMetadata?.(candidate, candidateIndex);
  if (candidateMetadata !== undefined && !isMetadataRecord(candidateMetadata)) {
    throw new TypeError("candidateMetadata must return an object when defined");
  }
  const metadata = {
    ...candidateMetadata,
    candidateIndex,
  };
  const attempt = createAttemptTask(candidate, candidateIndex, policy, decisions);
  const boundedAttempt = policy.deadlineAt === undefined ? attempt : run.deadline(attempt, policy.deadlineAt);
  const classifiedAttempt = classifyDeadlineFailure(boundedAttempt, candidate, candidateIndex, policy, decisions);
  const recordedAttempt = recorder.wrap(classifiedAttempt, {
    metadata,
    reasonCode: (error) => error instanceof ClassifiedCandidateError
      ? error.decision.reasonCode
      : undefined,
  });
  return run.retry(recordedAttempt, withClassifierRetry(policy.retry));
}

function createAttemptTask<C, T>(
  candidate: C,
  candidateIndex: number,
  policy: CandidatePolicy<C, T>,
  decisions: CandidateDecisionBuffer,
): TaskFn<AttemptResult<T>> {
  return async (ctx) => {
    let value: T;
    try {
      value = await policy.execute(candidate, ctx);
    } catch (error) {
      const classified = await classifyCandidateError(error, candidate, ctx, policy.classifyFailure);
      recordFailure(decisions, candidateIndex, classified.decision);
      throw classified;
    }

    try {
      const acceptance = normalizeAcceptanceDecision(await policy.accept(value, candidate, ctx));
      if (acceptance.accepted) {
        recordDecision(decisions, { candidateIndex, decision: "accepted" });
        return { accepted: true, value };
      }
      recordDecision(decisions, {
        candidateIndex,
        decision: "quality_rejected",
        reasonCode: acceptance.reasonCode,
      });
      return { accepted: false };
    } catch (error) {
      if (classifyKnownWorkItFailure(error) !== undefined) throw error;
      throw new CandidateCallbackError(error);
    }
  };
}

function classifyDeadlineFailure<C, T>(
  task: TaskFn<AttemptResult<T>>,
  candidate: C,
  candidateIndex: number,
  policy: CandidatePolicy<C, T>,
  decisions: CandidateDecisionBuffer,
): TaskFn<AttemptResult<T>> {
  return async (ctx) => {
    try {
      return await task(ctx);
    } catch (error) {
      if (error instanceof ClassifiedCandidateError || error instanceof CandidateCallbackError) throw error;
      const classified = await classifyCandidateError(error, candidate, ctx, policy.classifyFailure);
      recordFailure(decisions, candidateIndex, classified.decision);
      throw classified;
    }
  };
}

function withClassifierRetry(retry: RetryOpts): RetryOpts & {
  readonly retryIf: (error: unknown) => boolean;
} {
  const retryIf = (error: unknown) => error instanceof ClassifiedCandidateError
    && error.decision.disposition === "retry_same_candidate";
  return { ...retry, retryIf };
}

function resultFromFailure<C, T>(
  error: ClassifiedCandidateError,
  recorder: ReturnType<typeof createAttemptRecorder>,
  decisions: readonly CandidateDecisionRecord[],
): CandidateRunResult<C, T> | undefined {
  const evidence = readEvidence(recorder, decisions);
  if (error.decision.disposition === "terminal") {
    return {
      status: "terminal",
      reasonCode: error.decision.reasonCode,
      error: error.original,
      ...evidence,
    };
  }
  if (error.decision.disposition === "requires_user_input") {
    return {
      status: "requires_user_input",
      reasonCode: error.decision.reasonCode,
      ...evidence,
    };
  }
  return undefined;
}

function recordFailure(
  decisions: CandidateDecisionBuffer,
  candidateIndex: number,
  decision: CandidateActionDecision,
): void {
  recordDecision(decisions, {
    candidateIndex,
    decision: decision.disposition,
    reasonCode: decision.reasonCode,
  });
}

function recordDecision(buffer: CandidateDecisionBuffer, decision: CandidateDecisionRecord): void {
  if (buffer.records.length < buffer.limit) buffer.records.push(decision);
}

function readEvidence(
  recorder: ReturnType<typeof createAttemptRecorder>,
  decisions: readonly CandidateDecisionRecord[],
): Pick<CandidateRunResult<unknown, unknown>, "evidence" | "droppedEvidence"> {
  return {
    evidence: mapCandidateEvidence(recorder.attempts, decisions),
    droppedEvidence: recorder.droppedAttempts,
  };
}

function snapshotCandidates<C>(candidates: readonly C[]): readonly C[] {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  return Object.freeze(Array.prototype.slice.call(candidates) as C[]);
}

function normalizeCandidatePolicy<C, T>(
  candidates: readonly C[],
  opts: FirstAcceptableOptions<C, T>,
): CandidatePolicy<C, T> {
  if (typeof opts !== "object" || opts === null) throw new TypeError("options are required");
  const execute = opts.execute;
  const accept = opts.accept;
  const classifyFailure = opts.classifyFailure;
  if (typeof execute !== "function" || typeof accept !== "function" || typeof classifyFailure !== "function") {
    throw new TypeError("execute, accept, and classifyFailure must be functions");
  }
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_CANDIDATES) {
    throw new RangeError(`maxCandidates must be an integer between 1 and ${MAX_CANDIDATES}`);
  }
  if (candidates.length > maxCandidates) throw new RangeError("candidates length exceeds maxCandidates");
  const retry = snapshotRetryPolicy(opts.retry);
  if (candidates.length * retry.times > MAX_TOTAL_CANDIDATE_ATTEMPTS) {
    throw new RangeError(`total candidate attempts must not exceed ${MAX_TOTAL_CANDIDATE_ATTEMPTS}`);
  }
  const deadlineAt = normalizeDeadline(opts.deadlineAt);
  const candidateMetadata = opts.candidateMetadata;
  if (candidateMetadata !== undefined && typeof candidateMetadata !== "function") {
    throw new TypeError("candidateMetadata must be a function");
  }
  return Object.freeze({
    execute,
    accept,
    classifyFailure,
    retry,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    ...(candidateMetadata !== undefined ? { candidateMetadata } : {}),
  });
}

function snapshotRetryPolicy(value: CandidateRetryPolicy | undefined): RetryOpts {
  const retry = value ?? DEFAULT_RETRY_POLICY;
  if (typeof retry === "number") {
    validateRetryPolicy(retry);
    return Object.freeze({ times: retry });
  }
  if (Object.hasOwn(retry, "retryIf")) throw new TypeError("candidate retry policy must not define retryIf");
  const snapshot: RetryOpts = {
    times: retry.times,
    ...(retry.backoff !== undefined ? { backoff: retry.backoff } : {}),
    ...(retry.initialDelay !== undefined ? { initialDelay: retry.initialDelay } : {}),
    ...(retry.maxDelay !== undefined ? { maxDelay: retry.maxDelay } : {}),
    ...(retry.jitter !== undefined ? { jitter: retry.jitter } : {}),
    ...(retry.retryBudget !== undefined ? { retryBudget: retry.retryBudget } : {}),
  };
  validateRetryPolicy(snapshot);
  return Object.freeze(snapshot);
}

function normalizeDeadline(value: number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const deadlineAt = typeof value === "number" ? value : value.getTime();
  if (!Number.isFinite(deadlineAt)) throw new RangeError("deadlineAt must be a finite timestamp or valid Date");
  return deadlineAt;
}

function unwrapCallbackError(error: unknown): unknown {
  return error instanceof CandidateCallbackError ? error.original : error;
}

function isMetadataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
