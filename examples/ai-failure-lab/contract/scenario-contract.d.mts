/**
 * Type declarations for bounded WorkIt failure scenarios.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export type ScenarioSourceKind = "fixture" | "github_issues" | "open_meteo";
export type ScenarioRisk = "read_only" | "production_write";
export type ScenarioFailureClass = "transient" | "unavailable" | "invalid_request";

export interface ScenarioSource {
  readonly kind: ScenarioSourceKind;
  readonly label: string;
  readonly reference?: string;
}

export interface ScenarioPolicy {
  readonly minConfidence: number;
  readonly minEvidenceReferences: number;
  readonly deadlineMs: number;
  readonly retryLimit: number;
  readonly maxEvidenceAttempts: number;
}

export interface ScenarioSuccess {
  readonly type: "success";
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly action: string;
  readonly risk: ScenarioRisk;
}

export interface ScenarioFailure {
  readonly type: "failure";
  readonly failureClass: ScenarioFailureClass;
}

export type ScenarioCandidateOutcome = ScenarioSuccess | ScenarioFailure;

export interface ScenarioCandidate {
  readonly id: string;
  readonly name: string;
  readonly latencyMs: number;
  readonly outcomes: readonly ScenarioCandidateOutcome[];
}

export interface FailureScenario {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly source: ScenarioSource;
  readonly policy: ScenarioPolicy;
  readonly candidates: readonly ScenarioCandidate[];
}

export interface ScenarioLimits {
  readonly maxBytes: number;
  readonly maxCandidates: number;
  readonly maxOutcomesPerCandidate: number;
  readonly maxEvidenceReferences: number;
  readonly maxEvidenceAttempts: number;
  readonly maxStringLength: number;
  readonly maxDeadlineMs: number;
  readonly maxLatencyMs: number;
  readonly maxRetries: number;
}

export const SCENARIO_VERSION: 1;
export const SCENARIO_LIMITS: ScenarioLimits;

export class ScenarioContractError extends TypeError {
  readonly path: string;
}

export function parseScenarioJson(json: string): FailureScenario;
export function validateScenario(value: unknown): FailureScenario;
