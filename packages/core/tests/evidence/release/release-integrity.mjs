/**
 * Release evidence: public proof artifact and release policy documentation.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";

import { createSuite } from "../harness.mjs";

const suite = createSuite("release");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "REL-001",
  "public proof artifact has required release evidence keys",
  "benchmarks/public-proof.json exposes commands, fixtures, guides, and runtime matrix",
  async () => {
    const artifact = JSON.parse(await readFile(new URL("benchmarks/public-proof.json", root), "utf8"));
    const required = [
      "author",
      "spdxLicense",
      "artifact",
      "evidenceCommands",
      "benchmarkFixtures",
      "migrationGuides",
      "crossRuntimeMatrix",
    ];
    const missing = required.filter((key) => artifact[key] === undefined);

    return {
      ok: missing.length === 0
        && artifact.author === "Admilson B. F. Cossa"
        && artifact.spdxLicense === "Apache-2.0",
      missing,
      fixtureCount: artifact.benchmarkFixtures?.length ?? 0,
    };
  },
);

await suite.proof(
  "REL-002",
  "release policy documents signed tags and worker boundary",
  "SECURITY.md documents signed tags and structured-clone worker input",
  async () => {
    const text = await readFile(new URL("SECURITY.md", root), "utf8");
    const hasSignedTag = /release tags must be signed|signed release tags|git tag -s/i.test(text);
    return {
      ok: hasSignedTag
        && /structured.clone/i.test(text)
        && /worker/i.test(text),
      hasSignedTag,
      hasStructuredClone: /structured.clone/i.test(text),
      hasWorker: /worker/i.test(text),
    };
  },
);

await suite.proof(
  "REL-003",
  "release provenance gate verifies tag policy",
  "release-provenance script contains signed-tag verification logic",
  async () => {
    const text = await readFile(new URL("scripts/check-release-provenance.mjs", root), "utf8");
    return {
      ok: /tag\s+-v|tag\s+--verify|signed/i.test(text),
      hasVerifyHook: /tag\s+-v|tag\s+--verify|signed/i.test(text),
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
