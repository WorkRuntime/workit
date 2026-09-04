/**
 * Adversarial tests for editable scenario admission.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SCENARIO_LIMITS,
  ScenarioContractError,
  parseScenarioJson,
  validateScenario,
} from "../contract/scenario-contract.mjs";

const scenarioPaths = [
  "../scenarios/grounded-fallback.json",
  "../scenarios/approval-stop.json",
  "../scenarios/deadline-exhaustion.json",
];

test("all tracked scenario fixtures satisfy the bounded contract", async () => {
  for (const path of scenarioPaths) {
    const json = await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const scenario = parseScenarioJson(json);
    assert.equal(Object.isFrozen(scenario), true);
    assert.equal(Object.isFrozen(scenario.candidates), true);
  }
});

test("unknown credential-bearing fields are rejected", async () => {
  const scenario = await fixture();
  scenario.candidates[0].apiKey = "must-not-enter-the-lab";
  assert.throws(
    () => validateScenario(scenario),
    (error) => error instanceof ScenarioContractError
      && error.path === "$.candidates[0].apiKey",
  );
});

test("duplicate candidate identities are rejected", async () => {
  const scenario = await fixture();
  scenario.candidates[1].id = scenario.candidates[0].id;
  assert.throws(() => validateScenario(scenario), /duplicate candidate id/);
});

test("unbounded candidate sets are rejected", async () => {
  const scenario = await fixture();
  scenario.candidates = Array.from(
    { length: SCENARIO_LIMITS.maxCandidates + 1 },
    (_, index) => ({ ...scenario.candidates[0], id: `candidate-${index}` }),
  );
  assert.throws(() => validateScenario(scenario), /must contain between/);
});

test("oversized JSON is rejected before parsing", () => {
  const json = JSON.stringify({ padding: "x".repeat(SCENARIO_LIMITS.maxBytes) });
  assert.throws(() => parseScenarioJson(json), /scenario exceeds/);
});

test("prototype and non-finite policy values cannot enter the snapshot", async () => {
  const scenario = await fixture();
  scenario.policy.minConfidence = Number.NaN;
  assert.throws(() => validateScenario(scenario), /finite number/);
});

async function fixture() {
  const json = await readFile(
    fileURLToPath(new URL("../scenarios/grounded-fallback.json", import.meta.url)),
    "utf8",
  );
  return JSON.parse(json);
}
