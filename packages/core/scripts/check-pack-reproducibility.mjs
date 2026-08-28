/**
 * Reproducible packed-artifact gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const tempRoot = await mkdtemp(join(tmpdir(), "workit-reproducibility-"));

try {
  const first = await buildAndPack(join(tempRoot, "first"));
  const second = await buildAndPack(join(tempRoot, "second"));
  assert.equal(second.sha256, first.sha256, "two clean builds produced different package bytes");
  assert.equal(second.filename, first.filename, "two clean builds produced different package names");
  process.stdout.write(JSON.stringify({
    packageReproducibility: "ok",
    filename: first.filename,
    sha256: first.sha256,
  }) + "\n");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function buildAndPack(destination) {
  await mkdir(destination, { recursive: true });
  await runNpm(["run", "build"]);
  const { stdout } = await runNpm(["pack", "--json", "--pack-destination", destination]);
  const [result] = JSON.parse(stdout);
  const bytes = await readFile(join(destination, result.filename));
  return {
    filename: result.filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function runNpm(args) {
  const npmArgs = process.env.npm_execpath === undefined
    ? args
    : [process.env.npm_execpath, ...args];
  const executable = process.env.npm_execpath === undefined
    ? (process.platform === "win32" ? "npm.cmd" : "npm")
    : process.execPath;
  return execFileAsync(executable, npmArgs, {
    cwd: PACKAGE_ROOT,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
