/**
 * Runs all tracked publication evidence proofs.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = [
  "lifecycle/owned-work.mjs",
  "correctness/runtime-contracts.mjs",
  "security/worker-boundary.mjs",
  "release/release-integrity.mjs",
  "performance/benchmark-contracts.mjs",
];

const summary = {
  author: "Admilson B. F. Cossa",
  spdxLicense: "Apache-2.0",
  artifact: "workit-publication-evidence",
  proofs: [],
};

for (const file of files) {
  const startedAt = Date.now();
  const childResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
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

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures > 0 ? 1 : 0);
