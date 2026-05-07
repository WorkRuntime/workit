/**
 * Production dependency vulnerability gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Development tooling can have its own lifecycle, but the published runtime
 * package must not ship with known production dependency vulnerabilities.
 */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

let stdout = "";
try {
  ({ stdout } = await execFileAsync(process.execPath, [npmCli, "audit", "--omit=dev", "--json"], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  }));
} catch (err) {
  stdout = err?.stdout ?? "";
  if (stdout.length === 0) throw err;
}

const report = JSON.parse(stdout);
const total = report.metadata?.vulnerabilities?.total ?? 0;
if (total !== 0) {
  const names = Object.keys(report.vulnerabilities ?? {});
  throw new Error(`Production vulnerability gate failed with ${total} finding(s): ${names.join(", ")}`);
}

console.log("vulnerability-gate: npm production audit passed with 0 findings");
