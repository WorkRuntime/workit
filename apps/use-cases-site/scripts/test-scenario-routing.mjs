/**
 * Regression tests for shareable WorkIt AI Failure Lab scenario links.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScenarioRoute,
  FAILURE_LAB_SECTION_HASH,
  resolveScenarioId,
} from "../src/navigation/scenarioRoute.mjs";

const SCENARIO_IDS = Object.freeze([
  "grounded-fallback",
  "approval-stop",
  "deadline-exhaustion",
]);
const FALLBACK_ID = SCENARIO_IDS[0];

for (const scenarioId of SCENARIO_IDS) {
  test(`resolves the ${scenarioId} failure-lab link`, () => {
    assert.equal(resolveScenarioId(`?scenario=${scenarioId}`, SCENARIO_IDS, FALLBACK_ID), scenarioId);
  });
}

test("rejects unknown and encoded hostile scenario ids", () => {
  assert.equal(resolveScenarioId("?scenario=unknown", SCENARIO_IDS, FALLBACK_ID), FALLBACK_ID);
  assert.equal(resolveScenarioId("?scenario=%2F%2Fevil.example", SCENARIO_IDS, FALLBACK_ID), FALLBACK_ID);
});

test("builds a relative same-origin route and preserves the selected example", () => {
  const route = buildScenarioRoute(
    "https://workruntime.github.io/workit/?example=incident-decision-gate&source=reddit#use-cases",
    "approval-stop",
  );

  assert.equal(
    route,
    `/workit/?example=incident-decision-gate&source=reddit&scenario=approval-stop${FAILURE_LAB_SECTION_HASH}`,
  );
});
