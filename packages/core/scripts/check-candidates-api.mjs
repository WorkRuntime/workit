/**
 * Candidate subpath declaration API snapshot gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const DECLARATIONS = [
  ["../dist/candidates/index.d.ts", "./api-snapshots/candidates.index.d.ts"],
  ["../dist/candidates/types.d.ts", "./api-snapshots/candidates.types.d.ts"],
];

for (const [actualPath, snapshotPath] of DECLARATIONS) {
  const actual = await readFile(new URL(actualPath, import.meta.url), "utf8");
  const snapshot = await readFile(new URL(snapshotPath, import.meta.url), "utf8");
  assert.equal(
    normalizeNewlines(actual),
    normalizeNewlines(snapshot),
    `${actualPath} changed without an intentional candidate API snapshot update`,
  );
}

process.stdout.write(JSON.stringify({ candidateDeclarationApi: "locked", files: DECLARATIONS.length }) + "\n");

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

