/**
 * Release provenance policy gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local verification cannot mint GitHub OIDC provenance. This gate validates
 * the future release workflow while keeping the package non-publishable until
 * final release approval.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const workflow = await readFile(".github/workflows/release-provenance.yml", "utf8");
const codeowners = await readRequiredFile(".github/CODEOWNERS");
const dependabot = await readRequiredFile(".github/dependabot.yml");
const scorecard = await readRequiredFile(".github/workflows/scorecard.yml");
const requireRegistryDryRun = process.argv.includes("--registry-dry-run");

assert.equal(packageJson.name, "@workjs/core", "release package identity must remain @workjs/core");
assert.equal(packageJson.private, true, "package.json must remain private until final release approval");
assert.equal(packageJson.publishConfig?.access, "public", "publishConfig.access must be public");
assert.equal(packageJson.license, "Apache-2.0", "release license must remain Apache-2.0");
assert.ok(packageJson.files.includes("SECURITY.md"), "published package must include SECURITY.md");
assert.ok(packageJson.files.includes("CONTRIBUTING.md"), "published package must include CONTRIBUTING.md");
assert.match(workflow, /id-token:\s*write/u, "release workflow must allow OIDC id-token provenance");
assert.match(workflow, /attestations:\s*write/u, "release workflow must allow GitHub artifact attestations");
assert.match(workflow, /npm publish --provenance --access public/u, "release workflow must publish with npm provenance");
assert.match(workflow, /npm run verify/u, "release workflow must run full verification before publish");
assert.match(workflow, /npm run test:coverage/u, "release workflow must run coverage before publish");
assertShaPinnedActions(".github/workflows/release-provenance.yml", workflow);
assertShaPinnedActions(".github/workflows/scorecard.yml", scorecard);
assert.match(codeowners, /^\*\s+\S+/mu, "CODEOWNERS must assign a default owner for every path");
assert.match(dependabot, /package-ecosystem:\s*"npm"/u, "dependabot must monitor npm dependencies");
assert.match(dependabot, /package-ecosystem:\s*"github-actions"/u, "dependabot must monitor GitHub Actions");
assert.match(scorecard, /ossf\/scorecard-action@[a-f0-9]{40}/u, "Scorecard workflow must use a SHA-pinned action");
assert.match(scorecard, /security-events:\s*write/u, "Scorecard workflow must be able to upload SARIF");

if (!requireRegistryDryRun) {
  console.log("release-policy-gate: provenance workflow validated and package remains private");
  process.exit(0);
}

throw new Error(
  "npm registry dry-run is intentionally blocked while package.json has private: true. Finish release evaluations, prove @workjs npm scope ownership, then flip private to false in a scoped release commit."
);

async function readRequiredFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") throw new Error(`${path} is required for release hardening`);
    throw err;
  }
}

function assertShaPinnedActions(path, text) {
  for (const match of text.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/gu)) {
    assert.match(
      match[2],
      /^[a-f0-9]{40}$/u,
      `${path} must pin ${match[1]} to a full commit SHA, found ${match[2]}`
    );
  }
}
