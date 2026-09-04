/**
 * Smoke tests for real WorkIt execution of bounded incident scenarios.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseScenarioJson } from "../contract/scenario-contract.mjs";
import { runScenarioWithWorkIt } from "../runtime/run-scenario.mjs";

test("published WorkIt runtime accepts the grounded candidate", async () => {
  const result = await runScenarioWithWorkIt(await scenario("grounded-fallback"));
  assert.equal(result.execution, "workit_runtime");
  assert.equal(result.package, "@workit/core");
  assert.equal(result.status, "accepted");
  assert.equal(result.candidateId, "grounded-reasoner");
  assert.equal(result.retryBudget.spent, 1);
});

test("published WorkIt runtime stops before a production-write fallback", async () => {
  const result = await runScenarioWithWorkIt(await scenario("approval-stop"));
  assert.equal(result.status, "requires_user_input");
  assert.equal(result.reasonCode, "production_change_requires_approval");
  assert.equal(result.evidence.length, 1);
});

async function scenario(id) {
  const path = fileURLToPath(new URL(`../scenarios/${id}.json`, import.meta.url));
  return parseScenarioJson(await readFile(path, "utf8"));
}
