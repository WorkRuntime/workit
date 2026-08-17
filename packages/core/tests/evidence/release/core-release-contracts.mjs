/**
 * Release evidence for zero runtime dependencies and enforced size budgets.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createSuite } from "../harness.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const suite = createSuite("release");

await suite.proof(
  "REL-009",
  "published core has zero runtime dependencies",
  "package dependencies are absent and the generated CycloneDX SBOM contains no runtime components",
  async () => {
    const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    const sbom = JSON.parse(await readFile(resolve(packageRoot, "dist/workit-core.sbom.cdx.json"), "utf8"));
    const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
    return {
      ok: runtimeDependencies.length === 0 && Array.isArray(sbom.components) && sbom.components.length === 0,
      runtimeDependencies,
      sbomComponents: sbom.components?.length,
    };
  },
);

await suite.proof(
  "REL-010",
  "compiled package entrypoints stay within enforced size budgets",
  "the release size gate passes against compiled root, group, candidates ESM, and candidates CommonJS artifacts",
  async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/check-bundle-size.mjs"], {
      cwd: packageRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const measurements = stdout.trim().split(/\r?\n/u).filter(Boolean);
    return {
      ok: measurements.some((line) => line.startsWith("public-api:"))
        && measurements.some((line) => line.startsWith("core-group-import:"))
        && measurements.some((line) => line.startsWith("candidates-subpath:"))
        && measurements.some((line) => line.startsWith("candidates-commonjs:")),
      measurements,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
