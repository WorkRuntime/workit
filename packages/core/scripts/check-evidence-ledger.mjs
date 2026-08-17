/**
 * Validates the claim ledger against the proof manifest and captured results.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceProofs } from "../tests/evidence/manifest.mjs";
import { computeEvidenceSourceDigest } from "./evidence-source-digest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledger = await readJson("evidence/claims.json");
const capture = await readJson("coverage/evidence/latest.json");
const allowedStatuses = new Set([
  "deferred",
  "environment-blocked",
  "product-decision",
  "proven",
  "unproven",
]);
const proofManifest = new Set(evidenceProofs.map(({ file }) => `tests/evidence/${file}`));
const claimIds = new Set();

assert.equal(ledger.artifact, "workit-claim-ledger");
assert.ok(Array.isArray(ledger.allowedClasses));
assert.ok(Array.isArray(ledger.claims));

for (const claim of ledger.claims) {
  assert.match(claim.id, /^[A-Z]+-[0-9]{3}$/u, `invalid claim id: ${claim.id}`);
  assert.ok(!claimIds.has(claim.id), `duplicate claim id: ${claim.id}`);
  claimIds.add(claim.id);
  assert.ok(ledger.allowedClasses.includes(claim.class), `${claim.id} has invalid class`);
  assert.ok(allowedStatuses.has(claim.status), `${claim.id} has invalid status`);
  for (const field of ["title", "proof", "command", "expectedInvariant", "limitations"]) {
    assert.equal(typeof claim[field], "string", `${claim.id} is missing ${field}`);
    assert.ok(claim[field].length > 0, `${claim.id} has empty ${field}`);
  }
  await access(resolve(packageRoot, claim.proof));
  if (claim.command === "npm run test:evidence") {
    assert.ok(proofManifest.has(claim.proof), `${claim.id} proof is absent from evidence manifest`);
  }
}

assert.equal(capture.artifact, "workit-publication-evidence");
assert.equal(capture.schemaVersion, 2);
assert.equal(capture.failed, 0, "captured evidence contains failed proof files");
assert.equal(capture.sourceDigest, await computeEvidenceSourceDigest(packageRoot), "captured evidence is stale");

const resultById = new Map();
for (const result of capture.claimResults) {
  assert.ok(!resultById.has(result.id), `duplicate captured claim result: ${result.id}`);
  assert.ok(claimIds.has(result.id), `captured result has no ledger claim: ${result.id}`);
  resultById.set(result.id, result);
}

for (const claim of ledger.claims) {
  if (claim.status !== "proven" || claim.command !== "npm run test:evidence") continue;
  const result = resultById.get(claim.id);
  assert.ok(result, `${claim.id} has no captured actual result`);
  assert.equal(result.status, "pass", `${claim.id} captured result did not pass`);
  assert.equal(result.proof, claim.proof, `${claim.id} captured proof path differs from ledger`);
  assert.ok(result.actualResult !== undefined, `${claim.id} captured actual result is missing`);
}

process.stdout.write(JSON.stringify({
  evidenceLedger: "ok",
  claims: ledger.claims.length,
  capturedResults: capture.claimResults.length,
  sourceDigest: capture.sourceDigest,
}) + "\n");

async function readJson(path) {
  return JSON.parse(await readFile(resolve(packageRoot, path), "utf8"));
}
