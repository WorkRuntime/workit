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
import { promisify } from "node:util";
import {
  AUDIT_ATTEMPT_TIMEOUT_MS,
  verifyProductionDependencies,
} from "./vulnerability-gate.mjs";

const execFileAsync = promisify(execFile);

await verifyProductionDependencies({
  runAudit: () => runNpm(["audit", "--omit=dev", "--json"], {
    timeout: AUDIT_ATTEMPT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  }),
  onRetry: ({ nextAttempt, maxAttempts }) => {
    console.warn(`vulnerability-gate: audit unavailable; retrying ${nextAttempt}/${maxAttempts}`);
  },
});

console.log("vulnerability-gate: npm production audit passed with 0 findings");

async function runNpm(args, opts) {
  if (process.env.npm_execpath !== undefined) {
    return await execFileAsync(process.execPath, [process.env.npm_execpath, ...args], opts);
  }

  return await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", args, opts);
}
