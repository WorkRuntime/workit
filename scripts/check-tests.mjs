/**
 * Test-suite hygiene guard.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prevents focused or skipped tests from entering the validation path.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_ROOT = "tests";
const FORBIDDEN = /\b(?:describe|it|test)\s*\.\s*(?:only|skip|todo)\s*\(/g;
const failures = [];

for (const file of await listFiles(TEST_ROOT)) {
  if (!/\.(?:c|m)?js$|\.tsx?$/.test(file)) continue;
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(FORBIDDEN)) {
    failures.push(`${file}:${lineNumber(text, match.index ?? 0)} contains ${match[0]}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log("test-hygiene: no focused or skipped tests found");

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}
