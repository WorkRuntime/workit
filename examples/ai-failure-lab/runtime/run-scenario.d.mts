/**
 * Type declarations for the real WorkIt failure-scenario executor.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FailureScenario } from "../contract/scenario-contract.mjs";
import type { IncidentDecision } from "../policy/incident-policy.mjs";

export interface WorkItScenarioAttempt {
  readonly candidateId: string;
  readonly attempt: number;
  readonly decision: IncidentDecision;
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface WorkItScenarioResult {
  readonly execution: "workit_runtime";
  readonly package: "@workit/core";
  readonly scenarioId: string;
  readonly status: "accepted" | "exhausted" | "terminal" | "requires_user_input";
  readonly candidateId?: string;
  readonly action?: string;
  readonly reasonCode?: string;
  readonly durationMs: number;
  readonly retryBudget: Readonly<{ spent: number; limit: number; unit: string }>;
  readonly evidence: readonly WorkItScenarioAttempt[];
  readonly droppedEvidence: number;
}

export function runScenarioWithWorkIt(input: FailureScenario): Promise<WorkItScenarioResult>;
