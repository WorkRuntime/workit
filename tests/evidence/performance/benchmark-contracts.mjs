/**
 * Performance evidence: benchmark suite metadata and captured result contract.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, readFile } from "node:fs/promises";

import { createSuite } from "../harness.mjs";

const suite = createSuite("performance");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "PERF-001",
  "article benchmark suite has the expected executable coverage",
  "benchmarks/articles contains exactly 19 numbered benchmark scripts",
  async () => {
    const files = (await readdir(new URL("benchmarks/articles/", root)))
      .filter((file) => /^\d{2}-.*\.mjs$/.test(file))
      .sort();

    return {
      ok: files.length === 19 && files[0].startsWith("01-") && files.at(-1).startsWith("19-"),
      count: files.length,
      first: files[0],
      last: files.at(-1),
    };
  },
);

await suite.proof(
  "PERF-002",
  "captured article benchmark result is machine-readable",
  "benchmarks/results/articles.latest.json records 19 passing benches",
  async () => {
    const text = await readFile(new URL("benchmarks/results/articles.latest.json", root), "utf8");
    const result = JSON.parse(text);

    return {
      ok: result.passed === 19
        && result.failed === 0
        && Array.isArray(result.benches)
        && result.benches.length === 19,
      passed: result.passed,
      failed: result.failed,
      count: result.benches?.length ?? 0,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
