/**
 * Curated editable datasets for the public AI Failure Lab.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import approvalStop from "../../../../examples/ai-failure-lab/scenarios/approval-stop.json?raw";
import deadlineExhaustion from "../../../../examples/ai-failure-lab/scenarios/deadline-exhaustion.json?raw";
import groundedFallback from "../../../../examples/ai-failure-lab/scenarios/grounded-fallback.json?raw";

export interface ScenarioPreset {
  readonly id: string;
  readonly label: string;
  readonly json: string;
}

export const scenarioPresets: readonly ScenarioPreset[] = Object.freeze([
  { id: "grounded-fallback", label: "Unsupported 200 OK", json: groundedFallback },
  { id: "approval-stop", label: "Rollback needs approval", json: approvalStop },
  { id: "deadline-exhaustion", label: "Global deadline", json: deadlineExhaustion },
]);

export const defaultScenarioPreset = scenarioPresets[0]!;
