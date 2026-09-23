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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const packageRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const workflow = await readFile(new URL(".github/workflows/release-provenance.yml", repoRoot), "utf8");
const security = await readFile("SECURITY.md", "utf8");
const codeowners = await readRequiredFile(new URL(".github/CODEOWNERS", repoRoot));
const allowedSigners = await readRequiredFile(new URL(".github/allowed_signers", repoRoot));
const dependabot = await readRequiredFile(new URL(".github/dependabot.yml", repoRoot));
const ci = await readRequiredFile(new URL(".github/workflows/ci.yml", repoRoot));
const scorecard = await readRequiredFile(new URL(".github/workflows/scorecard.yml", repoRoot));
const requireRegistryDryRun = process.argv.includes("--registry-dry-run");
const execFileAsync = promisify(execFile);

assert.equal(packageJson.name, "@workit/core", "release package identity must remain @workit/core");
assert.equal(packageJson.private, false, "package.json must be publishable after final release approval");
assert.equal(packageJson.publishConfig?.access, "public", "publishConfig.access must be public");
assert.equal(packageJson.license, "Apache-2.0", "release license must remain Apache-2.0");
assert.equal(
  packageJson.repository?.url,
  "git+https://github.com/WorkRuntime/workit.git",
  "package repository.url must match GitHub provenance repository"
);
assert.equal(
  packageJson.bugs?.url,
  "https://github.com/WorkRuntime/workit/issues",
  "package bug tracker must point at the public repository"
);
assert.equal(
  packageJson.homepage,
  "https://github.com/WorkRuntime/workit#readme",
  "package homepage must point at the public README"
);
assert.ok(packageJson.files.includes("SECURITY.md"), "published package must include SECURITY.md");
assert.ok(packageJson.files.includes("CONTRIBUTING.md"), "published package must include CONTRIBUTING.md");
assert.match(workflow, /id-token:\s*write/u, "release workflow must allow OIDC id-token provenance");
assert.match(workflow, /attestations:\s*write/u, "release workflow must allow GitHub artifact attestations");
assert.doesNotMatch(
  workflow,
  /(?:NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.[A-Z0-9_]*NPM[A-Z0-9_]*)/u,
  "release workflow must use npm Trusted Publishing instead of persistent npm credentials"
);
const trustedPublishingNpmVersion = readPinnedNpmVersion(workflow);
assert.ok(
  compareVersions(trustedPublishingNpmVersion, "11.5.1") >= 0,
  `npm Trusted Publishing requires npm >=11.5.1, found ${trustedPublishingNpmVersion}`
);
assert.match(
  workflow,
  /npm install --global "npm@\$TRUSTED_PUBLISHING_NPM_VERSION"/u,
  "release workflow must install the pinned Trusted Publishing npm client"
);
assert.match(
  workflow,
  /test -n "\$ACTIONS_ID_TOKEN_REQUEST_URL"/u,
  "release workflow must fail closed when the GitHub OIDC request URL is unavailable"
);
assert.match(
  workflow,
  /test -n "\$ACTIONS_ID_TOKEN_REQUEST_TOKEN"/u,
  "release workflow must fail closed when the GitHub OIDC request token is unavailable"
);
assert.match(workflow, /npm publish --workspace @workit\/core --provenance --access public/u, "release workflow must publish @workit/core with npm provenance");
assert.match(workflow, /npm run verify/u, "release workflow must run full verification before publish");
assert.match(workflow, /npm run test:coverage/u, "release workflow must run coverage before publish");
assert.match(
  workflow,
  /npm run check:release-readiness/u,
  "release workflow must reject unresolved release-blocking evidence"
);
assert.match(
  workflow,
  /dry_run_version="0\.0\.0-dry-run\.\$\{GITHUB_RUN_ID\}\.\$\{GITHUB_RUN_ATTEMPT\}"/u,
  "release dry runs must use a unique ephemeral version instead of colliding with a published version"
);
assert.match(
  workflow,
  /npm pkg set "version=\$dry_run_version" --workspace @workit\/core/u,
  "the ephemeral dry-run version must be scoped to @workit/core"
);
assert.match(
  workflow,
  /npm publish --workspace @workit\/core --provenance --access public --tag dry-run --dry-run/u,
  "release dry runs must use a non-latest prerelease tag"
);
assert.match(workflow, /gpg\.ssh\.allowedSignersFile/u, "release workflow must configure SSH allowed signers before tag verification");
assert.match(workflow, /fetch-depth:\s*0/u, "release workflow must fetch signed tag objects and release history");
assert.ok(
  workflow.includes('test "$GITHUB_REF_TYPE" = "tag"'),
  "non-dry-run publishing must require a tag ref"
);
assert.ok(
  workflow.includes('test "$GITHUB_REF_NAME" = "v$package_version"'),
  "release tag must match the package version"
);
assert.ok(
  workflow.includes('git tag -v "$GITHUB_REF_NAME"'),
  "release workflow must verify the selected signed tag"
);
assert.match(workflow, /oven-sh\/setup-bun@[a-f0-9]{40}/u, "release workflow must provision Bun for package-consumer verification");
assert.match(workflow, /denoland\/setup-deno@[a-f0-9]{40}/u, "release workflow must provision Deno for package-consumer verification");
assert.match(workflow, /bun-version:\s*"1\.3\.13"/u, "release workflow must pin the Bun fixture version");
assert.match(workflow, /deno-version:\s*"2\.2\.7"/u, "release workflow must pin the Deno fixture version");
assert.match(ci, /node-version:\s*\["20\.11\.1", "22\.x", "24\.x"\]/u, "CI must test every supported Node release line");
assert.match(workflow, /node-version:\s*\["20\.11\.1", "22\.x", "24\.x"\]/u, "release workflow must test every supported Node release line");
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
  console.log("release-policy-gate: provenance workflow and publication shape validated; evidence readiness is a separate gate");
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

function readPinnedNpmVersion(text) {
  const match = text.match(/TRUSTED_PUBLISHING_NPM_VERSION:\s*"(?<version>\d+\.\d+\.\d+)"/u);
  assert.ok(match?.groups?.version, "release workflow must pin the npm Trusted Publishing client");
  return match.groups.version;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function assertExistingTagsAreSigned() {
  const { stdout } = await execFileAsync("git", ["tag", "--list"], { cwd: fileURLToPath(repoRoot) });
  for (const tag of stdout.split(/\r?\n/u).filter(Boolean)) {
    await execFileAsync("git", ["tag", "-v", tag], { cwd: fileURLToPath(repoRoot) });
  }
}

async function runNpm(args) {
  if (process.env.npm_execpath !== undefined) {
    await execFileAsync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: fileURLToPath(packageRoot),
      timeout: 120_000,
    });
    return;
  }

  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFileAsync(npmExecutable, args, { cwd: fileURLToPath(packageRoot), timeout: 120_000 });
}
