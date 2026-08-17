/**
 * Public contracts for deterministic candidate selection.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AttemptRecorderOptions, WorkItAttemptEvidence } from "../replay/index.js";
import type { RetryOpts, TaskContext } from "../types/index.js";
/** Policy outcome assigned to a failed candidate attempt. */
export type FailureDisposition = "retry_same_candidate" | "try_next_candidate" | "terminal" | "cancelled" | "requires_user_input";
/** Bounded, machine-readable classification of a candidate failure. */
export interface CandidateFailureDecision {
    readonly disposition: FailureDisposition;
    readonly reasonCode: string;
}
/** Failure decisions a provider classifier may return. Real cancellation is detected by WorkIt. */
export interface CandidateActionDecision extends CandidateFailureDecision {
    readonly disposition: Exclude<FailureDisposition, "cancelled">;
}
/** Semantic quality decision kept separate from transport success. */
export type AcceptanceDecision = {
    readonly accepted: true;
} | {
    readonly accepted: false;
    readonly reasonCode: string;
};
/** Candidate-level interpretation of one recorded task-body invocation. */
export type CandidateAttemptDecision = CandidateActionDecision["disposition"] | "quality_rejected" | "accepted";
/** Bounded attempt evidence enriched with candidate and quality policy facts. */
export interface CandidateAttemptEvidence extends WorkItAttemptEvidence {
    readonly candidateIndex: number;
    readonly decision: CandidateAttemptDecision;
}
interface CandidateResultEvidence {
    readonly evidence: readonly CandidateAttemptEvidence[];
    readonly droppedEvidence: number;
}
/** Exhaustive expected outcome of a candidate selection run. */
export type CandidateRunResult<C, T> = (CandidateResultEvidence & {
    readonly status: "accepted";
    readonly candidate: C;
    readonly candidateIndex: number;
    readonly value: T;
}) | (CandidateResultEvidence & {
    readonly status: "exhausted";
}) | (CandidateResultEvidence & {
    readonly status: "terminal";
    readonly reasonCode: string;
    readonly error: unknown;
}) | (CandidateResultEvidence & {
    readonly status: "requires_user_input";
    readonly reasonCode: string;
});
/** Retry policy whose admission predicate is owned by the failure classifier. */
export type CandidateRetryPolicy = number | Omit<RetryOpts, "retryIf">;
/** Candidate selection policy and bounded evidence controls. */
export interface FirstAcceptableOptions<C, T> {
    readonly execute: (candidate: C, ctx: TaskContext) => T | Promise<T>;
    readonly accept: (value: T, candidate: C, ctx: TaskContext) => AcceptanceDecision | Promise<AcceptanceDecision>;
    readonly classifyFailure: (error: unknown, candidate: C, ctx: TaskContext) => CandidateActionDecision | Promise<CandidateActionDecision>;
    readonly retry?: CandidateRetryPolicy;
    readonly maxCandidates?: number;
    readonly deadlineAt?: number | Date;
    readonly evidence?: AttemptRecorderOptions;
    readonly candidateMetadata?: (candidate: C, candidateIndex: number) => Readonly<Record<string, unknown>> | undefined;
}
export {};
