/**
 * Candidate failure and quality decision validation.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BudgetExceededError,
  CancellationError,
  TimeoutError,
  type TaskContext,
} from "../types/index.js";
import type {
  AcceptanceDecision,
  CandidateActionDecision,
  CandidateFailureDecision,
  FirstAcceptableOptions,
} from "./types.js";

const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const ACTION_DISPOSITIONS = new Set<CandidateActionDecision["disposition"]>([
  "retry_same_candidate",
  "try_next_candidate",
  "terminal",
  "requires_user_input",
]);

const WORKIT_BUDGET_EXHAUSTED = Object.freeze<CandidateActionDecision>({
  disposition: "terminal",
  reasonCode: "workit_budget_exhausted",
});
const WORKIT_TIMEOUT = Object.freeze<CandidateActionDecision>({
  disposition: "terminal",
  reasonCode: "workit_timeout",
});
const WORKIT_CANCELLED = Object.freeze<CandidateFailureDecision>({
  disposition: "cancelled",
  reasonCode: "workit_cancelled",
});

const WORKIT_FAILURE_CLASSIFIERS: ReadonlyArray<{
  readonly matches: (error: unknown) => boolean;
  readonly decision: CandidateFailureDecision;
}> = Object.freeze([
  {
    matches: (error) => safeInstanceOf(error, BudgetExceededError),
    decision: WORKIT_BUDGET_EXHAUSTED,
  },
  {
    matches: (error) => safeInstanceOf(error, TimeoutError),
    decision: WORKIT_TIMEOUT,
  },
  {
    matches: (error) => safeInstanceOf(error, CancellationError),
    decision: WORKIT_CANCELLED,
  },
]);

/** Returns the safe built-in classification for a known WorkIt runtime error. */
export function classifyWorkItFailure(error: unknown): CandidateFailureDecision | undefined {
  return WORKIT_FAILURE_CLASSIFIERS.find((classifier) => classifier.matches(error))?.decision;
}

export class ClassifiedCandidateError extends Error {
  readonly decision: CandidateActionDecision;
  readonly original: unknown;

  constructor(original: unknown, decision: CandidateActionDecision) {
    super(readErrorMessage(original));
    this.name = readErrorName(original);
    this.original = original;
    this.decision = decision;
  }
}

export class CandidateCallbackError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super("candidate policy callback failed");
    this.name = "CandidateCallbackError";
    this.original = original;
  }
}

export async function classifyCandidateError<C, T>(
  error: unknown,
  candidate: C,
  ctx: TaskContext,
  classify: FirstAcceptableOptions<C, T>["classifyFailure"],
): Promise<ClassifiedCandidateError> {
  const builtIn = classifyWorkItFailure(error);
  if (builtIn?.disposition === "cancelled") throw error;

  let decision: CandidateActionDecision;
  try {
    decision = builtIn as CandidateActionDecision | undefined
      ?? normalizeActionDecision(await classify(error, candidate, ctx));
  } catch (callbackError) {
    if (classifyWorkItFailure(callbackError) !== undefined) throw callbackError;
    throw new CandidateCallbackError(callbackError);
  }
  return new ClassifiedCandidateError(error, decision);
}

export function normalizeAcceptanceDecision(value: unknown): AcceptanceDecision {
  if (!isRecord(value)) {
    throw new TypeError("accept must return an AcceptanceDecision");
  }
  const accepted = value.accepted;
  if (typeof accepted !== "boolean") throw new TypeError("accept must return an AcceptanceDecision");
  if (accepted) return Object.freeze({ accepted: true });
  const reasonCode = value.reasonCode;
  assertReasonCode(reasonCode);
  return Object.freeze({ accepted: false, reasonCode });
}

function normalizeActionDecision(value: unknown): CandidateActionDecision {
  if (!isRecord(value)) {
    throw new TypeError("classifyFailure returned an invalid disposition");
  }
  const disposition = value.disposition;
  if (!ACTION_DISPOSITIONS.has(disposition as CandidateActionDecision["disposition"])) {
    throw new TypeError("classifyFailure returned an invalid disposition");
  }
  const reasonCode = value.reasonCode;
  assertReasonCode(reasonCode);
  return Object.freeze({
    disposition: disposition as CandidateActionDecision["disposition"],
    reasonCode,
  });
}

function assertReasonCode(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REASON_CODE_PATTERN.test(value)) {
    throw new RangeError("reasonCode must match /^[a-z][a-z0-9_]{0,127}$/");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorName(error: unknown): string {
  return readErrorProperty(error, "name", "Error");
}

function readErrorMessage(error: unknown): string {
  if (safeInstanceOf(error, Error)) return readErrorProperty(error, "message", "Candidate attempt failed");
  return typeof error === "string" ? error : "Candidate attempt failed";
}

function readErrorProperty(error: unknown, key: "name" | "message", fallback: string): string {
  try {
    const value = (error as Error)[key];
    return typeof value === "string" ? value.slice(0, 1_024) : fallback;
  } catch {
    return fallback;
  }
}

function safeInstanceOf(
  value: unknown,
  errorType: { readonly [Symbol.hasInstance]: (candidate: unknown) => boolean },
): boolean {
  try {
    return errorType[Symbol.hasInstance](value);
  } catch {
    return false;
  }
}
