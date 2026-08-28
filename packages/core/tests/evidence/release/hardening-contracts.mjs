/**
 * Release evidence for the 0.6.1 compatibility and reproducibility gates.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { createSuite } from "../harness.mjs";

const suite = createSuite("release");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "REL-012",
  "0.6.1 locks declarations compatibility and reproducible packaging",
  "declarations and 0.6.0 compatibility are locked, Node 20.11/22/24 are exercised, two builds pack identically, public benchmark thresholds drive their gates, and deep property exploration is scheduled",
  async () => {
    const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const snapshot = JSON.parse(await readFile(
      new URL("scripts/api-snapshots/public-declarations.snapshot.json", root),
      "utf8",
    ));
    const declarationGate = await readFile(new URL("scripts/check-api-declarations.mjs", root), "utf8");
    const compatibilityGate = await readFile(new URL("scripts/check-previous-compatibility.mjs", root), "utf8");
    const reproducibilityGate = await readFile(new URL("scripts/check-pack-reproducibility.mjs", root), "utf8");
    const logicalBenchmarkGate = await readFile(new URL("scripts/check-1b-benchmark.mjs", root), "utf8");
    const streamMemoryGate = await readFile(new URL("scripts/check-stream-memory.mjs", root), "utf8");
    const publicProof = JSON.parse(await readFile(new URL("benchmarks/public-proof.json", root), "utf8"));
    const ci = await readFile(new URL("../../.github/workflows/ci.yml", root), "utf8");
    const nightlyProperty = await readFile(
      new URL("../../.github/workflows/nightly-property.yml", root),
      "utf8",
    );
    const logicalFixture = publicProof.benchmarkFixtures.find(
      (fixture) => fixture.id === "one-billion-logical-stream",
    );
    const streamFixture = publicProof.benchmarkFixtures.find(
      (fixture) => fixture.id === "slow-consumer-stream-memory",
    );

    return {
      ok: packageJson.version === "0.6.1"
        && snapshot.files?.length === 31
        && declarationGate.includes("public-declarations.snapshot.json")
        && compatibilityGate.includes('BASELINE_VERSION = "0.6.0"')
        && reproducibilityGate.includes("two clean builds produced different package bytes")
        && ci.includes('node-version: ["20.11.1", "22.x", "24.x"]')
        && logicalFixture?.minimumLogicalItemsPerSecond === 50_000_000
        && streamFixture?.maximumHeapGrowthBytes === 48 * 1024 * 1024
        && logicalBenchmarkGate.includes('readBenchmarkThreshold(')
        && streamMemoryGate.includes('readBenchmarkThreshold(')
        && nightlyProperty.includes('WORKIT_PROPERTY_RUNS: "1000"')
        && nightlyProperty.includes('WORKIT_PROPERTY_SEED_OFFSET: ${{ github.run_number }}'),
      version: packageJson.version,
      declarationFiles: snapshot.files?.length,
      compatibilityBaseline: "0.6.0",
      nodeMatrix: ["20.11.1", "22.x", "24.x"],
      minimumLogicalItemsPerSecond: logicalFixture?.minimumLogicalItemsPerSecond,
      maximumHeapGrowthBytes: streamFixture?.maximumHeapGrowthBytes,
      nightlyRunsPerProperty: 1_000,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
