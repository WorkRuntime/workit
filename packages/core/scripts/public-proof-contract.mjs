/**
 * Public proof artifact accessors.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Benchmark gates read their release thresholds from the published proof
 * artifact through this module. The artifact is therefore the single source
 * of truth rather than a second, potentially drifting description of a gate.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PUBLIC_PROOF_URL = new URL("../benchmarks/public-proof.json", import.meta.url);

export async function readPublicProof() {
  return JSON.parse(await readFile(PUBLIC_PROOF_URL, "utf8"));
}

export function requireBenchmarkFixture(artifact, id) {
  const matches = artifact.benchmarkFixtures.filter((fixture) => fixture.id === id);
  assert.equal(matches.length, 1, `expected exactly one public proof fixture: ${id}`);
  return matches[0];
}

export function requirePositiveSafeInteger(fixture, field) {
  const value = fixture[field];
  assert.ok(
    Number.isSafeInteger(value) && value > 0,
    `${fixture.id}.${field} must be a positive safe integer`
  );
  return value;
}

export async function readBenchmarkThreshold(id, field) {
  const artifact = await readPublicProof();
  return requirePositiveSafeInteger(requireBenchmarkFixture(artifact, id), field);
}
