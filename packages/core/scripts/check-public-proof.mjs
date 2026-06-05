/**
 * Public proof artifact gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The proof artifact is useful only if it is tied to executable commands and
 * user-facing migration guidance. This gate validates the static artifact
 * shape, required evidence commands, cross-runtime rows, and README anchors.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const artifact = JSON.parse(await readFile("benchmarks/public-proof.json", "utf8"));
const readme = await readFile("README.md", "utf8");
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

const REQUIRED_COMMANDS = [
  "npm run check:benchmark",
  "npm run check:1b",
  "npm run check:stream-memory",
  "npm run check:soak",
  "npm run check:package-consumer",
  "npm run check:claims",
];

const REQUIRED_MIGRATIONS = ["p-limit", "p-map", "RxJS", "Bottleneck"];
const REQUIRED_RUNTIMES = [
  "Node.js ESM",
  "Node.js CommonJS",
  "Express",
  "Fastify",
  "tRPC",
  "Next.js route",
  "Vercel AI SDK handler",
  "AWS Lambda handler",
  "Azure Functions handler",
  "Browser and edge workers",
];

assert.equal(artifact.author, "Admilson B. F. Cossa");
assert.equal(artifact.spdxLicense, "Apache-2.0");
assert.equal(artifact.artifact, "workit-public-proof");
assert.equal(artifact.version, 1);

for (const command of REQUIRED_COMMANDS) {
  assert.ok(artifact.evidenceCommands.includes(command), `missing evidence command: ${command}`);
  const scriptName = command.replace("npm run ", "");
  assert.ok(packageJson.scripts[scriptName] !== undefined, `missing package script: ${scriptName}`);
}

for (const migration of REQUIRED_MIGRATIONS) {
  assert.ok(artifact.migrationGuides.includes(migration), `missing migration artifact row: ${migration}`);
  assert.ok(readme.includes(`### From ${migration}`), `missing README migration guide: ${migration}`);
}

for (const runtime of REQUIRED_RUNTIMES) {
  assert.ok(
    artifact.crossRuntimeMatrix.some((row) => row.runtime === runtime && typeof row.evidence === "string"),
    `missing runtime matrix row: ${runtime}`
  );
}

assert.ok(
  artifact.benchmarkFixtures.length >= 5,
  "public proof must include benchmark, stream, and soak fixtures"
);
assert.ok(
  readme.includes("benchmarks/public-proof.json"),
  "README must point reviewers to the public proof artifact"
);

console.log(JSON.stringify({
  publicProof: "ok",
  evidenceCommands: artifact.evidenceCommands.length,
  migrationGuides: artifact.migrationGuides.length,
  runtimes: artifact.crossRuntimeMatrix.length,
}));
