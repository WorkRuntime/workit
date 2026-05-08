/**
 * benchmarks/articles/run-all.mjs -- runs every bench in the folder and emits
 * one consolidated JSON report to stdout.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const files = (await readdir(here))
  .filter((f) => /^\d{2}-.*\.mjs$/.test(f))
  .sort();

const summary = { author: "Admilson B. F. Cossa", spdxLicense: "Apache-2.0", benches: [] };

for (const file of files) {
  const t0 = Date.now();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  const wallMs = Date.now() - t0;
  let parsed = null;
  try { parsed = JSON.parse(out.stdout); } catch { /* leave null */ }
  summary.benches.push({
    file,
    exitCode: out.code,
    wallMs,
    stderr: out.stderr.trim() || null,
    report: parsed,
  });
  if (out.code !== 0) {
    process.stderr.write(`FAIL ${file} (exit ${out.code})\n${out.stderr}\n`);
  }
}

const failures = summary.benches.filter((b) => b.exitCode !== 0).length;
summary.passed = summary.benches.length - failures;
summary.failed = failures;

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures > 0 ? 1 : 0);
