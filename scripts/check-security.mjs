/**
 * Release security policy gate for WorkJS.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This static gate covers checks that do not require external services:
 * dependency shape, lifecycle scripts, package file policy, source-map release
 * policy, high-confidence secret markers, and dynamic code execution hazards.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const failures = [];
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const tsconfig = JSON.parse(stripJsonComments(await readFile("tsconfig.json", "utf8")));
const securityPolicy = await readFile("SECURITY.md", "utf8");
const rootLock = packageLock.packages?.[""] ?? {};

const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
if (runtimeDependencies.length > 0) {
  failures.push(`Runtime dependencies must stay empty: ${runtimeDependencies.join(", ")}`);
}

if (packageLock.name !== packageJson.name || rootLock.name !== packageJson.name) {
  failures.push("package-lock package name must match package.json");
}

for (const [name, version] of Object.entries(packageJson.devDependencies ?? {})) {
  if (/^[~^*]/.test(version) || version.includes(" - ") || version === "latest") {
    failures.push(`Development dependency "${name}" must be pinned, found "${version}"`);
  }
}

if (JSON.stringify(rootLock.devDependencies ?? {}) !== JSON.stringify(packageJson.devDependencies ?? {})) {
  failures.push("package-lock root devDependencies must match package.json exactly");
}

if (JSON.stringify(rootLock.peerDependencies ?? {}) !== JSON.stringify(packageJson.peerDependencies ?? {})) {
  failures.push("package-lock root peerDependencies must match package.json exactly");
}

for (const lifecycle of ["preinstall", "install", "postinstall"]) {
  if (packageJson.scripts?.[lifecycle] !== undefined) {
    failures.push(`Lifecycle install script "${lifecycle}" is not allowed`);
  }
}

for (const requiredFile of ["CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "dist", "dist-cjs", "SECURITY.md"]) {
  if (!packageJson.files?.includes(requiredFile)) {
    failures.push(`package.json#files must include ${requiredFile}`);
  }
}

if (tsconfig.compilerOptions?.sourceMap !== false || tsconfig.compilerOptions?.declarationMap !== false) {
  failures.push("Release builds must disable sourceMap and declarationMap");
}

if (!/Security contact:\s*admilsoncossa@gmail\.com/u.test(securityPolicy)) {
  failures.push("SECURITY.md must name the explicit security contact address");
}

if (!/PGP encryption:/u.test(securityPolicy)) {
  failures.push("SECURITY.md must document the PGP encryption reporting path");
}

await assertNoFiles(["dist", "dist-cjs"], /\.map$/u, "Published artifacts must not include source maps");
await assertNoTextMatches(
  [".github", "src", "scripts", "samples", "tests", "README.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md"],
  [
    /AKIA[0-9A-Z]{16}/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /xox[baprs]-[A-Za-z0-9-]{10,}/u,
    /ghp_[A-Za-z0-9]{20,}/u,
    /sk-[A-Za-z0-9]{32,}/u,
  ],
  "High-confidence secret marker found"
);
await assertNoTextMatches(["src"], [/\beval\s*\(/u, /\bFunction\s*\(/u], "Dynamic code execution is not allowed in src");

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log("security-gate: static release checks passed");

async function assertNoFiles(paths, pattern, message) {
  for (const path of await listExistingFiles(paths)) {
    if (pattern.test(path.replaceAll("\\", "/"))) failures.push(`${message}: ${path}`);
  }
}

async function assertNoTextMatches(paths, patterns, message) {
  for (const path of await listExistingFiles(paths)) {
    if (!/\.(?:[cm]?[jt]s|json|md|tsx?)$/u.test(path)) continue;
    const text = await readFile(path, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(text)) failures.push(`${message}: ${path}`);
    }
  }
}

async function listExistingFiles(paths) {
  const out = [];
  for (const path of paths) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      await collectFiles(path, entries, out);
    } catch (err) {
      if (err?.code !== "ENOTDIR") {
        try {
          await readFile(path);
          out.push(path);
        } catch (fileErr) {
          if (fileErr?.code !== "ENOENT") throw fileErr;
        }
      } else {
        out.push(path);
      }
    }
  }
  return out;
}

async function collectFiles(dir, entries, out) {
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, await readdir(path, { withFileTypes: true }), out);
    } else {
      out.push(path);
    }
  }
}

function stripJsonComments(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}
