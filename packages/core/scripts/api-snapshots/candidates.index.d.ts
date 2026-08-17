/**
 * Deterministic candidate selection with typed failure and quality policy.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Candidate execution is sequential and may repeat side effects. Callers own
 * idempotency for side-effecting operations.
 */
import type { CandidateFailureDecision, CandidateRunResult, FirstAcceptableOptions } from "./types.js";
export type { AcceptanceDecision, CandidateActionDecision, CandidateAttemptDecision, CandidateAttemptEvidence, CandidateFailureDecision, CandidateRetryPolicy, CandidateRunResult, FailureDisposition, FirstAcceptableOptions, } from "./types.js";
/** Returns the safe built-in classification for a known WorkIt runtime error. */
export declare function classifyWorkItFailure(error: unknown): CandidateFailureDecision | undefined;
/** Selects the first semantically acceptable result in deterministic candidate order. */
export declare function firstAcceptable<C, T>(candidates: readonly C[], opts: FirstAcceptableOptions<C, T>): Promise<CandidateRunResult<C, T>>;
