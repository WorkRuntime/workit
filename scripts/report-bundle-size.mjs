/**
 * Bundle contribution report for WorkJS package entrypoints.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This report uses esbuild metafiles against compiled output so size work is
 * based on the artifact consumers import, not source-level assumptions.
 */

import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const TOP_INPUTS = Number.parseInt(process.env.WORKJS_BUNDLE_TOP ?? "8", 10);

const ENTRIES = [
  {
    name: "public-api",
    source: 'export * from "./dist/index.js";',
  },
  {
    name: "core-group-import",
    source: 'export { group } from "./dist/index.js";',
  },
  {
    name: "direct-scope-group",
    source: 'export { group } from "./dist/engine/scope.js";',
  },
  {
    name: "direct-run-import",
    source: 'export { run } from "./dist/run/index.js";',
  },
  {
    name: "direct-work-import",
    source: 'export { work } from "./dist/work/index.js";',
  },
];

for (const entry of ENTRIES) {
  const result = await build({
    stdin: {
      contents: entry.source,
      resolveDir: process.cwd(),
      sourcefile: `${entry.name}.js`,
    },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    treeShaking: true,
    metafile: true,
    write: false,
    logLevel: "silent",
  });

  const output = result.outputFiles[0].contents;
  const outputMeta = Object.values(result.metafile.outputs)[0];
  const inputs = Object.entries(outputMeta.inputs)
    .map(([path, meta]) => ({ path, bytes: meta.bytesInOutput }))
    .sort((a, b) => b.bytes - a.bytes);

  console.log(`\n${entry.name}: ${output.length} B minified, ${gzipSync(output, { level: 9 }).length} B gzip`);
  for (const input of inputs.slice(0, TOP_INPUTS)) {
    console.log(`  ${input.bytes.toString().padStart(6)} B  ${input.path}`);
  }
}
