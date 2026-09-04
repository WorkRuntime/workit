/**
 * Decision-parity gate between the browser model and published WorkIt runtime.
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
import { runScenarioWithWorkIt } from "../runtime/run-scenario.mjs";

const scenarioIds = [
  "grounded-fallback",
  "approval-stop",
  "deadline-exhaustion",
];

for (const scenarioId of scenarioIds) {
  test(`preview and WorkIt runtime preserve decision parity for ${scenarioId}`, async () => {
    const scenario = await readScenario(scenarioId);
    const preview = previewScenario(scenario);
    const runtime = await runScenarioWithWorkIt(scenario);

    assert.deepEqual(decisionContract(runtime), decisionContract(preview));
  });
}

function decisionContract(result) {
  return {
    status: result.status,
    reasonCode: result.reasonCode,
    acceptedCandidate: result.status === "accepted" ? result.candidateId : undefined,
    acceptedAction: result.status === "accepted" ? result.action : undefined,
    retryBudget: {
      spent: result.retryBudget.spent,
      limit: result.retryBudget.limit,
    },
    decisions: result.evidence.map(({ candidateId, attempt, decision, reasonCode }) => ({
      candidateId,
      attempt,
      decision,
      reasonCode,
    })),
    droppedEvidence: result.droppedEvidence,
  };
}

async function readScenario(id) {
  const path = fileURLToPath(new URL(`../scenarios/${id}.json`, import.meta.url));
  return parseScenarioJson(await readFile(path, "utf8"));
}
