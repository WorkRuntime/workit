/**
 * Computes the source digest bound to a captured evidence run.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const EVIDENCE_SOURCE_PATHS = Object.freeze([
  "../../package-lock.json",
  "../../package.json",
  "README.md",
  "SECURITY.md",
  "benchmarks",
  "evidence/claims.json",
  "evidence/oryn-candidate-canary.v0.6.0.json",
  "evidence/oryn-hardening-canary.v0.6.1.json",
  "package.json",
  "samples",
  "scripts",
  "src",
  "tests",
  "tsconfig.json",
  "vitest.config.ts",
]);

/** Returns a stable digest over runtime, public API, ledger, and proof sources. */
export async function computeEvidenceSourceDigest(packageRoot) {
  const root = resolve(packageRoot);
  const ledger = JSON.parse(await readFile(resolve(root, "evidence/claims.json"), "utf8"));
  const paths = new Set([
    ...EVIDENCE_SOURCE_PATHS,
    ...ledger.claims.map(({ proof }) => proof),
  ]);
  const files = new Set();
  for (const path of paths) {
    await collectFiles(resolve(root, path), files);
  }
  const orderedFiles = [...files].sort((left, right) => left.localeCompare(right));

  const digest = createHash("sha256");
  for (const file of orderedFiles) {
    const logicalPath = relative(root, file).replaceAll("\\", "/");
    digest.update(logicalPath);
    digest.update("\0");
    digest.update(await readFile(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function collectFiles(path, files) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOTDIR") return null;
    throw error;
  });
  if (entries === null) {
    files.add(path);
    return;
  }
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await collectFiles(child, files);
    if (entry.isFile()) files.add(child);
  }
}
