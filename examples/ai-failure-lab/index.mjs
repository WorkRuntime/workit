/**
 * Command-line entry point for a real WorkIt failure-scenario run.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseScenarioJson } from "./contract/scenario-contract.mjs";
import { runScenarioWithWorkIt } from "./runtime/run-scenario.mjs";

const SCENARIO_IDS = new Set([
  "grounded-fallback",
  "approval-stop",
  "deadline-exhaustion",
]);

const scenarioId = process.argv[2] ?? "grounded-fallback";
if (!SCENARIO_IDS.has(scenarioId)) {
  throw new RangeError(`Unknown scenario ${scenarioId}.`);
}

const path = fileURLToPath(new URL(`./scenarios/${scenarioId}.json`, import.meta.url));
const scenario = parseScenarioJson(await readFile(path, "utf8"));
const result = await runScenarioWithWorkIt(scenario);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
