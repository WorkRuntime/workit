/**
 * Type declarations for the incident decision policy.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ScenarioFailureClass,
  ScenarioPolicy,
  ScenarioSuccess,
} from "../contract/scenario-contract.mjs";

export type IncidentDecision =
  | "accepted"
  | "quality_rejected"
  | "retry_same_candidate"
  | "try_next_candidate"
  | "terminal"
  | "requires_user_input";

export interface IncidentPolicyDecision {
  readonly disposition: IncidentDecision;
  readonly reasonCode?: string;
}

export const INCIDENT_DECISION: Readonly<Record<string, IncidentDecision>>;
export const INCIDENT_REASON: Readonly<Record<string, string>>;

export function assessRecommendation(
  value: ScenarioSuccess,
  policy: ScenarioPolicy,
): IncidentPolicyDecision;

export function classifyProviderFailure(
  failureClass: ScenarioFailureClass,
): IncidentPolicyDecision;
