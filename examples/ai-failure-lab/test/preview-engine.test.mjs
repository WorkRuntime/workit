/**
 * Behavioral tests for the browser-only policy preview.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseScenarioJson } from "../contract/scenario-contract.mjs";
import { previewScenario } from "../policy/preview-engine.mjs";

test("preview rejects weak quality, spends one retry, and accepts grounded output", async () => {
  const result = previewScenario(await scenario("grounded-fallback"));
  assert.equal(result.execution, "policy_preview");
  assert.equal(result.status, "accepted");
  assert.equal(result.candidateId, "grounded-reasoner");
  assert.equal(result.action, "collect_diagnostics");
  assert.equal(result.retryBudget.spent, 1);
  assert.deepEqual(result.evidence.map(({ decision }) => decision), [
    "quality_rejected",
    "retry_same_candidate",
    "accepted",
  ]);
});

test("preview stops at human authority before later candidates", async () => {
  const result = previewScenario(await scenario("approval-stop"));
  assert.equal(result.status, "requires_user_input");
  assert.equal(result.candidateId, "rollback-planner");
  assert.equal(result.reasonCode, "production_change_requires_approval");
  assert.equal(result.evidence.length, 1);
});

test("preview enforces one end-to-end deadline", async () => {
  const result = previewScenario(await scenario("deadline-exhaustion"));
  assert.equal(result.status, "terminal");
  assert.equal(result.reasonCode, "workit_timeout");
  assert.equal(result.elapsedMs, 150);
  assert.equal(result.evidence.length, 1);
});

test("preview makes evidence overflow explicit", async () => {
  const fixture = JSON.parse(JSON.stringify(await scenario("grounded-fallback")));
  fixture.policy.maxEvidenceAttempts = 1;
  const result = previewScenario(fixture);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.droppedEvidence, 2);
});

async function scenario(id) {
  const path = fileURLToPath(new URL(`../scenarios/${id}.json`, import.meta.url));
  return parseScenarioJson(await readFile(path, "utf8"));
}
