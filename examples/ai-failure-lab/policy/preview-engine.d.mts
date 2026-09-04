/**
 * Type declarations for deterministic policy previews.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FailureScenario } from "../contract/scenario-contract.mjs";
import type { IncidentDecision } from "./incident-policy.mjs";

export interface PreviewAttemptEvidence {
  readonly candidateId: string;
  readonly attempt: number;
  readonly elapsedMs: number;
  readonly decision: IncidentDecision;
  readonly reasonCode?: string;
  readonly failureClass?: string;
  readonly confidence?: number;
  readonly evidenceReferences?: number;
  readonly action?: string;
  readonly risk?: string;
}

export interface ScenarioPreviewResult {
  readonly status: "accepted" | "exhausted" | "terminal" | "requires_user_input";
  readonly candidateId?: string;
  readonly action?: string;
  readonly reasonCode?: string;
  readonly elapsedMs: number;
  readonly retryBudget: Readonly<{ spent: number; limit?: number }>;
  readonly evidence: readonly PreviewAttemptEvidence[];
  readonly droppedEvidence: number;
  readonly execution: "policy_preview";
}

export function previewScenario(input: FailureScenario): ScenarioPreviewResult;
