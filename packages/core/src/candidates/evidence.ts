/**
 * Bounded candidate evidence mapping over the shared attempt recorder.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  WorkItAttemptEvidence,
  WorkItReceiptError,
} from "../replay/index.js";
import type {
  CandidateAttemptDecision,
  CandidateAttemptEvidence,
} from "./types.js";

const MAX_ERROR_NAME_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;

export interface CandidateDecisionRecord {
  readonly candidateIndex: number;
  readonly decision: CandidateAttemptDecision;
  readonly reasonCode?: string;
}

export function mapCandidateEvidence(
  attempts: readonly WorkItAttemptEvidence[],
  decisions: readonly CandidateDecisionRecord[],
): readonly CandidateAttemptEvidence[] {
  return attempts.map((attempt, index) => {
    const decision = decisions[index]!;
    return {
      ...attempt,
      candidateIndex: decision.candidateIndex,
      decision: decision.decision,
      ...(decision.reasonCode !== undefined ? { reasonCode: decision.reasonCode } : {}),
      ...(attempt.error !== undefined ? { error: boundError(attempt.error) } : {}),
    };
  });
}

function boundError(error: WorkItReceiptError): WorkItReceiptError {
  return {
    name: truncate(error.name, MAX_ERROR_NAME_LENGTH),
    message: truncate(error.message, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}
