/**
 * Runs all tracked publication evidence proofs.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeEvidenceSourceDigest } from "../../scripts/evidence-source-digest.mjs";
import { evidenceProofs } from "./manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const options = parseArguments(process.argv.slice(2));

const summary = {
  author: "Admilson B. F. Cossa",
  spdxLicense: "Apache-2.0",
  artifact: "workit-publication-evidence",
  schemaVersion: 2,
  releaseTarget: options.releaseTarget,
  sourceDigest: await computeEvidenceSourceDigest(packageRoot),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  proofs: [],
};

for (const proof of evidenceProofs) {
  const { file, nodeArguments } = proof;
  const startedAt = Date.now();
  const childResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArguments, path.join(here, file)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });

  const jsonStart = childResult.stdout.lastIndexOf('{\n  "area":');
  let report = null;
  if (jsonStart >= 0) {
    try {
      report = JSON.parse(childResult.stdout.slice(jsonStart));
    } catch {
      report = null;
    }
  }

  summary.proofs.push({
    file,
    exitCode: childResult.code,
    wallMs: Date.now() - startedAt,
    stderr: childResult.stderr.trim() || null,
    report,
  });

  process.stderr.write(childResult.stderr);
  process.stdout.write(childResult.stdout);
}

const failures = summary.proofs.filter((proof) => proof.exitCode !== 0).length;
summary.passed = summary.proofs.length - failures;
summary.failed = failures;
summary.claimResults = summary.proofs.flatMap((proof) =>
  (proof.report?.results ?? []).map((result) => ({
    id: result.id,
    proof: `tests/evidence/${proof.file}`,
    status: result.status,
    actualResult: result.evidence,
  }))
);

const serialized = JSON.stringify(summary, null, 2) + "\n";
if (options.output !== undefined) {
  const output = resolveOutput(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serialized, "utf8");
}
process.stdout.write(serialized);
process.exit(failures > 0 ? 1 : 0);

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if ((name !== "--output" && name !== "--release-target") || value === undefined) {
      throw new Error("Usage: run-all.mjs [--output <package-relative-path>] [--release-target <version>]");
    }
    values.set(name, value);
  }
  return {
    output: values.get("--output"),
    releaseTarget: values.get("--release-target") ?? null,
  };
}

function resolveOutput(value) {
  const output = path.resolve(packageRoot, value);
  const relative = path.relative(packageRoot, output);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Evidence output must remain inside the package root");
  }
  return output;
}
