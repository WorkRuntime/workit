/**
 * Bundle size quality gate for WorkIt.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The check bundles compiled output in memory so it measures the artifact that
 * package consumers import. Budgets are intentionally set to the current
 * verified runtime-framework baseline and should be ratcheted down as the
 * runtime is optimized.
 */

import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const DIST_ENTRY = "./dist/index.js";

const BUDGETS = [
  {
    name: "public-api",
    source: `export * from "${DIST_ENTRY}";`,
    maxMinifiedBytes: 29_500,
    maxGzipBytes: 9_700,
  },
  {
    name: "core-group-import",
    source: `export { group } from "${DIST_ENTRY}";`,
    maxMinifiedBytes: 15_000,
    maxGzipBytes: 5_000,
  },
];

const failures = [];

for (const budget of BUDGETS) {
  const result = await build({
    stdin: {
      contents: budget.source,
      resolveDir: process.cwd(),
      sourcefile: `${budget.name}.js`,
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    treeShaking: true,
    write: false,
    logLevel: "silent",
  });

  const minifiedBytes = result.outputFiles[0].contents.length;
  const gzipBytes = gzipSync(result.outputFiles[0].contents, { level: 9 }).length;

  console.log(
    `${budget.name}: ${minifiedBytes} B minified, ${gzipBytes} B gzip ` +
      `(limits ${budget.maxMinifiedBytes} B / ${budget.maxGzipBytes} B)`
  );

  if (minifiedBytes > budget.maxMinifiedBytes || gzipBytes > budget.maxGzipBytes) {
    failures.push(`${budget.name} exceeded configured bundle budget`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
