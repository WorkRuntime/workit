/**
 * Installed-package compatibility gate against the previous public release.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const BASELINE_VERSION = "0.6.0";
const OPENTELEMETRY_VERSION = "1.9.1";
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_PATH = fileURLToPath(
  new URL("./compatibility-fixtures/v0.6.0-consumer.ts", import.meta.url),
);
const require = createRequire(import.meta.url);
const TYPESCRIPT_CLI = require.resolve("typescript/bin/tsc");
const PACKAGE_PATHS = Object.freeze([
  "@workit/core",
  "@workit/core/activity",
  "@workit/core/ai",
  "@workit/core/analysis",
  "@workit/core/candidates",
  "@workit/core/channel",
  "@workit/core/contracts",
  "@workit/core/diagnostics",
  "@workit/core/fault",
  "@workit/core/ledger",
  "@workit/core/observability",
  "@workit/core/otel",
  "@workit/core/replay",
  "@workit/core/resources",
  "@workit/core/time-policy",
  "@workit/core/worker",
]);
const COMMONJS_PATHS = PACKAGE_PATHS.filter((path) => path !== "@workit/core/worker");
const execFileAsync = promisify(execFile);
const tempRoot = await mkdtemp(join(tmpdir(), "workit-previous-compatibility-"));

try {
  const packDirectory = join(tempRoot, "package");
  await mkdir(packDirectory, { recursive: true });
  const { stdout } = await runNpm(["pack", "--json", "--pack-destination", packDirectory], PACKAGE_ROOT);
  const [pack] = JSON.parse(stdout);
  const currentTarball = join(packDirectory, pack.filename);

  const previous = await installAndInspect(
    join(tempRoot, "previous"),
    `@workit/core@${BASELINE_VERSION}`,
  );
  const current = await installAndInspect(join(tempRoot, "current"), currentTarball);

  assert.deepEqual(current.esmExports, previous.esmExports, "ESM runtime exports changed from 0.6.0");
  assert.deepEqual(current.cjsExports, previous.cjsExports, "CommonJS runtime exports changed from 0.6.0");
  assert.deepEqual(current.declarations, previous.declarations, "TypeScript declarations changed from 0.6.0");

  process.stdout.write(JSON.stringify({
    previousCompatibility: "ok",
    baseline: BASELINE_VERSION,
    packagePaths: PACKAGE_PATHS.length,
    declarations: Object.keys(current.declarations).length,
  }) + "\n");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function installAndInspect(directory, packageSpec) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`, "utf8");
  await runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    packageSpec,
    `@opentelemetry/api@${OPENTELEMETRY_VERSION}`,
  ], directory);
  await copyFile(FIXTURE_PATH, join(directory, "compatibility.ts"));
  await writeFile(join(directory, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      skipLibCheck: false,
      types: [],
    },
    include: ["compatibility.ts"],
  }, null, 2)}\n`, "utf8");
  await execFileAsync(process.execPath, [TYPESCRIPT_CLI, "--project", "tsconfig.json"], {
    cwd: directory,
    timeout: 120_000,
  });

  const esmExports = await probeRuntimeExports(directory, "esm", PACKAGE_PATHS);
  const cjsExports = await probeRuntimeExports(directory, "cjs", COMMONJS_PATHS);
  const declarations = await readDeclarations(join(directory, "node_modules", "@workit", "core", "dist"));
  return { esmExports, cjsExports, declarations };
}

async function probeRuntimeExports(directory, format, paths) {
  const extension = format === "esm" ? "mjs" : "cjs";
  const probePath = join(directory, `runtime-probe.${extension}`);
  const expression = format === "esm"
    ? `await Promise.all(PACKAGE_PATHS.map(async (path) => [path, Object.keys(await import(path)).sort()]))`
    : `PACKAGE_PATHS.map((path) => [path, Object.keys(require(path)).sort()])`;
  await writeFile(probePath, [
    `const PACKAGE_PATHS = ${JSON.stringify(paths)};`,
    `const entries = ${expression};`,
    "process.stdout.write(JSON.stringify(Object.fromEntries(entries)));",
    "",
  ].join("\n"), "utf8");
  const { stdout } = await execFileAsync(process.execPath, [probePath], {
    cwd: directory,
    timeout: 120_000,
  });
  return JSON.parse(stdout);
}

async function readDeclarations(root) {
  const declarations = {};
  for (const path of await collectDeclarations(root)) {
    declarations[relative(root, path).replaceAll("\\", "/")] =
      (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  }
  return declarations;
}

async function collectDeclarations(root) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectDeclarations(path)));
    if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

async function runNpm(args, cwd) {
  const npmArgs = process.env.npm_execpath === undefined
    ? args
    : [process.env.npm_execpath, ...args];
  const executable = process.env.npm_execpath === undefined
    ? (process.platform === "win32" ? "npm.cmd" : "npm")
    : process.execPath;
  return execFileAsync(executable, npmArgs, {
    cwd,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
