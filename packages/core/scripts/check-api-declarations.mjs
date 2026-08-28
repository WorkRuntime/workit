/**
 * Complete TypeScript declaration API snapshot gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every generated declaration is part of at least one published entrypoint's
 * type graph. The canonical snapshot makes type-only changes visible before
 * they become part of the 1.0 compatibility contract.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST_ROOT = resolve(PACKAGE_ROOT, "dist");
const SNAPSHOT_PATH = fileURLToPath(
  new URL("./api-snapshots/public-declarations.snapshot.json", import.meta.url),
);
const UPDATE_FLAG = "--update";
const packageJson = JSON.parse(await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8"));
const snapshot = await createSnapshot();

for (const [subpath, conditions] of Object.entries(packageJson.exports)) {
  const declarationPath = conditions.types?.replace(/^\.\//u, "");
  assert.equal(typeof declarationPath, "string", `${subpath} must expose a declaration entrypoint`);
  assert.ok(
    snapshot.files.some(({ path }) => path === declarationPath),
    `${subpath} declaration entrypoint ${declarationPath} is absent from the API snapshot`,
  );
}

if (process.argv.includes(UPDATE_FLAG)) {
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ declarationApi: "updated", files: snapshot.files.length }) + "\n");
  process.exit(0);
}

const expected = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
assert.deepEqual(snapshot, expected, `public declarations changed; review them and run this gate with ${UPDATE_FLAG}`);
process.stdout.write(JSON.stringify({ declarationApi: "locked", files: snapshot.files.length }) + "\n");

async function createSnapshot() {
  const declarationFiles = await collectDeclarationFiles(DIST_ROOT);
  return {
    schemaVersion: 1,
    files: await Promise.all(declarationFiles.map(async (path) => ({
      path: relative(PACKAGE_ROOT, path).replaceAll("\\", "/"),
      contents: normalizeNewlines(await readFile(path, "utf8")),
    }))),
  };
}

async function collectDeclarationFiles(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectDeclarationFiles(path));
    if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}
