/**
 * Release evidence for the 1.0 public contract freeze.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { isReleaseAtOrAfter, isReleaseOnMajorLine } from "../../../scripts/release-line.mjs";
import { createSuite } from "../harness.mjs";

/** Release that froze the surface. Its changelog entry must stay published. */
const FREEZE_VERSION = "1.0.0";
/** Major line the freeze covers: every 1.x release keeps the frozen surface. */
const FROZEN_MAJOR = 1;
const STABLE_ENTRYPOINT_COUNT = 16;
const suite = createSuite("release");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "REL-014",
  "1.0 freezes the documented package surface",
  "every 1.x package declares all 16 entrypoints stable and checks runtime exports and declarations against a published 1.x baseline no newer than itself",
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

    const compatibilityBaseline = compatibilityGate.match(
      /BASELINE_VERSION = "(?<version>[^"]+)"/u,
    )?.groups?.version;

    return {
      ok: isReleaseOnMajorLine(packageJson.version, FROZEN_MAJOR)
        && entrypoints.length === STABLE_ENTRYPOINT_COUNT
        && stableRows.length === STABLE_ENTRYPOINT_COUNT
        && changelog.includes(`## ${FREEZE_VERSION}`)
        && isReleaseAtOrAfter(compatibilityBaseline, FREEZE_VERSION)
        && isReleaseAtOrAfter(packageJson.version, compatibilityBaseline),
      version: packageJson.version,
      compatibilityBaseline,
      entrypoints,
      stableEntrypoints: stableRows.length,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
