/**
 * Release provenance policy gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local verification cannot mint GitHub OIDC provenance. This gate validates
 * the release workflow, signed-tag policy, and publishable package state. When
 * asked for a registry dry run, it also exercises the npm publish path without
 * creating a public version.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const workflow = await readFile(".github/workflows/release-provenance.yml", "utf8");
const security = await readFile("SECURITY.md", "utf8");
const codeowners = await readRequiredFile(".github/CODEOWNERS");
const allowedSigners = await readRequiredFile(".github/allowed_signers");
const dependabot = await readRequiredFile(".github/dependabot.yml");
const ci = await readRequiredFile(".github/workflows/ci.yml");
const scorecard = await readRequiredFile(".github/workflows/scorecard.yml");
const requireRegistryDryRun = process.argv.includes("--registry-dry-run");
const execFileAsync = promisify(execFile);

assert.equal(packageJson.name, "@workit/core", "release package identity must remain @workit/core");
assert.equal(packageJson.private, false, "package.json must be publishable after final release approval");
assert.equal(packageJson.publishConfig?.access, "public", "publishConfig.access must be public");
assert.equal(packageJson.license, "Apache-2.0", "release license must remain Apache-2.0");
assert.ok(packageJson.files.includes("SECURITY.md"), "published package must include SECURITY.md");
assert.ok(packageJson.files.includes("CONTRIBUTING.md"), "published package must include CONTRIBUTING.md");
assert.match(workflow, /id-token:\s*write/u, "release workflow must allow OIDC id-token provenance");
assert.match(workflow, /attestations:\s*write/u, "release workflow must allow GitHub artifact attestations");
assert.match(workflow, /npm publish --provenance --access public/u, "release workflow must publish with npm provenance");
assert.match(workflow, /npm run verify/u, "release workflow must run full verification before publish");
assert.match(workflow, /npm run test:coverage/u, "release workflow must run coverage before publish");
assert.match(workflow, /gpg\.ssh\.allowedSignersFile/u, "release workflow must configure SSH allowed signers before tag verification");
assert.match(workflow, /oven-sh\/setup-bun@[a-f0-9]{40}/u, "release workflow must provision Bun for package-consumer verification");
assert.match(workflow, /denoland\/setup-deno@[a-f0-9]{40}/u, "release workflow must provision Deno for package-consumer verification");
assert.match(workflow, /bun-version:\s*"1\.3\.13"/u, "release workflow must pin the Bun fixture version");
assert.match(workflow, /deno-version:\s*"2\.2\.7"/u, "release workflow must pin the Deno fixture version");
assert.match(security, /git tag -s/u, "SECURITY.md must require signed release tags");
assert.match(security, /git tag -v/u, "SECURITY.md must document signed tag verification");
assertShaPinnedActions(".github/workflows/release-provenance.yml", workflow);
assertShaPinnedActions(".github/workflows/ci.yml", ci);
assertShaPinnedActions(".github/workflows/scorecard.yml", scorecard);
assert.match(codeowners, /^\*\s+\S+/mu, "CODEOWNERS must assign a default owner for every path");
assert.match(dependabot, /package-ecosystem:\s*"npm"/u, "dependabot must monitor npm dependencies");
assert.match(dependabot, /package-ecosystem:\s*"github-actions"/u, "dependabot must monitor GitHub Actions");
assert.match(scorecard, /ossf\/scorecard-action@[a-f0-9]{40}/u, "Scorecard workflow must use a SHA-pinned action");
assert.match(scorecard, /security-events:\s*write/u, "Scorecard workflow must be able to upload SARIF");
assert.match(allowedSigners, /admilsoncossa@gmail\.com ssh-ed25519 /u, "release allowed signers must trust the release signing key");
await assertExistingTagsAreSigned();

if (!requireRegistryDryRun) {
  console.log("release-policy-gate: provenance workflow validated and package is publishable");
  process.exit(0);
}

await runNpm(["publish", "--dry-run", "--access", "public"]);
console.log("release-policy-gate: npm publish dry run completed");

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

async function assertExistingTagsAreSigned() {
  const { stdout } = await execFileAsync("git", ["tag", "--list"]);
  for (const tag of stdout.split(/\r?\n/u).filter(Boolean)) {
    await execFileAsync("git", ["tag", "-v", tag]);
  }
}

async function runNpm(args) {
  if (process.env.npm_execpath !== undefined) {
    await execFileAsync(process.execPath, [process.env.npm_execpath, ...args], {
      timeout: 120_000,
    });
    return;
  }

  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFileAsync(npmExecutable, args, { timeout: 120_000 });
}
