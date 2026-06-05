/**
 * Source documentation and authorship gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Release-critical source, test, script, sample, workflow, and policy files must
 * carry authorship and SPDX metadata. Generated artifacts and ignored local
 * docs are intentionally excluded.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const REQUIRED_ROOTS = [
  ".github",
  "samples",
  "scripts",
  "src",
  "tests",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
];
const failures = [];

for (const path of await listExistingFiles(REQUIRED_ROOTS)) {
  if (!isTextPolicyFile(path)) continue;
  const text = await readFile(path, "utf8");
  if (!text.includes("Admilson B. F. Cossa")) failures.push(`${path} is missing author metadata`);
  if (!text.includes("SPDX-License-Identifier: Apache-2.0")) failures.push(`${path} is missing SPDX metadata`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log("header-gate: author and SPDX metadata validated");

function isTextPolicyFile(path) {
  return /\.(?:[cm]?[jt]s|md|ya?ml|tsx?)$/u.test(path)
    || path.replaceAll("\\", "/") === ".github/CODEOWNERS";
}

async function listExistingFiles(paths) {
  const out = [];
  for (const path of paths) await collect(path, out);
  return out;
}

async function collect(path, out) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) await collect(join(path, entry.name), out);
  } catch (err) {
    if (err?.code === "ENOTDIR") out.push(path);
    else if (err?.code !== "ENOENT") throw err;
  }
}
