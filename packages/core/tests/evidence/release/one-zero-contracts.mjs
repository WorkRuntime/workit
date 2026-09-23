/**
 * Release evidence for the 1.0 public contract freeze.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { createSuite } from "../harness.mjs";

const RELEASE_VERSION = "1.0.0";
const COMPATIBILITY_BASELINE = "0.6.1";
const STABLE_ENTRYPOINT_COUNT = 16;
const suite = createSuite("release");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "REL-014",
  "1.0 freezes the documented package surface",
  "the 1.0 package declares all 16 entrypoints stable and checks runtime exports and declarations against 0.6.1",
  async () => {
    const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const readme = await readFile(new URL("README.md", root), "utf8");
    const changelog = await readFile(new URL("../../CHANGELOG.md", root), "utf8");
    const compatibilityGate = await readFile(
      new URL("scripts/check-previous-compatibility.mjs", root),
      "utf8",
    );
    const entrypoints = Object.keys(packageJson.exports ?? {});
    const stableRows = entrypoints.filter((entrypoint) => {
      const publishedPath = entrypoint === "."
        ? "@workit/core"
        : `@workit/core${entrypoint.slice(1)}`;
      return readme.includes(`| \`${publishedPath}\` | stable |`);
    });

    return {
      ok: packageJson.version === RELEASE_VERSION
        && entrypoints.length === STABLE_ENTRYPOINT_COUNT
        && stableRows.length === STABLE_ENTRYPOINT_COUNT
        && changelog.includes(`## ${RELEASE_VERSION}`)
        && compatibilityGate.includes(`BASELINE_VERSION = "${COMPATIBILITY_BASELINE}"`),
      version: packageJson.version,
      compatibilityBaseline: COMPATIBILITY_BASELINE,
      entrypoints,
      stableEntrypoints: stableRows.length,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
