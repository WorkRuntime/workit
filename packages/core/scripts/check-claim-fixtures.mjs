/**
 * Verifies sample-to-claim evidence fixtures.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Samples are useful only if they prove exact claims. This gate executes each
 * unique sample once and evaluates the claim fixture assertions against the
 * sample's JSON output.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimFixtures } from "../samples/claim-fixtures.mjs";

const execFileAsync = promisify(execFile);
const sampleResults = new Map();

for (const fixture of claimFixtures) {
  const result = await getSampleResult(fixture.sample);
  try {
    fixture.verify(result);
  } catch (err) {
    throw new Error(`Claim fixture "${fixture.id}" failed: ${err.message}`);
  }
}

console.log(JSON.stringify({
  claimFixtures: "ok",
  claims: claimFixtures.length,
  samples: sampleResults.size,
}));

async function getSampleResult(path) {
  const cached = sampleResults.get(path);
  if (cached !== undefined) return cached;

  const { stdout } = await execFileAsync(process.execPath, [path], {
    cwd: process.cwd(),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim());
  sampleResults.set(path, parsed);
  return parsed;
}
