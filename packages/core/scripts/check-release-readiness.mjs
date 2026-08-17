/**
 * Rejects publication while the evidence ledger has unresolved release blockers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { summarizeEvidenceLedger } from "./evidence-ledger-status.mjs";

const ledger = JSON.parse(await readFile(new URL("../evidence/claims.json", import.meta.url), "utf8"));
assert.equal(ledger.artifact, "workit-claim-ledger", "release readiness requires the claim ledger");

const releaseStatus = summarizeEvidenceLedger(ledger.claims);
process.stdout.write(JSON.stringify({
  releaseEvidence: releaseStatus.releaseReadiness,
  releaseBlockers: releaseStatus.releaseBlockers,
}) + "\n");

assert.equal(
  releaseStatus.releaseBlockers.length,
  0,
  `release evidence is blocked by ${releaseStatus.releaseBlockers.map(({ id, status }) => `${id}:${status}`).join(", ")}`,
);
