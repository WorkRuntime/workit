/**
 * CommonJS compatibility build for Node consumers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The source of truth remains the ESM TypeScript build in `dist/`. This script
 * creates explicit CommonJS entry bundles for consumers that still use
 * `require("@workit/core")`.
 */

import { rm } from "node:fs/promises";
import { build } from "esbuild";

const candidateSharedRuntimePlugin = {
  name: "candidate-shared-runtime",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^\.\.\/run\/index\.js$/ }, (args) =>
      isCandidateModule(args.importer, "index.js")
        ? { path: "@workit/core", external: true }
        : undefined);
    buildContext.onResolve({ filter: /^\.\.\/replay\/index\.js$/ }, (args) =>
      isCandidateModule(args.importer, "index.js")
        ? { path: "@workit/core/replay", external: true }
        : undefined);
    buildContext.onResolve({ filter: /^\.\.\/types\/index\.js$/ }, (args) =>
      isCandidateModule(args.importer, "classification.js")
        ? { path: "@workit/core", external: true }
        : undefined);
  },
};

const ENTRIES = [
  { entry: "dist/index.js", outfile: "dist-cjs/index.cjs" },
  { entry: "dist/activity/index.js", outfile: "dist-cjs/activity/index.cjs" },
  { entry: "dist/ai/index.js", outfile: "dist-cjs/ai/index.cjs" },
  { entry: "dist/analysis/index.js", outfile: "dist-cjs/analysis/index.cjs" },
  { entry: "dist/channel/index.js", outfile: "dist-cjs/channel/index.cjs" },
  {
    entry: "dist/candidates/index.js",
    outfile: "dist-cjs/candidates/index.cjs",
    plugins: [candidateSharedRuntimePlugin],
  },
  { entry: "dist/contracts/index.js", outfile: "dist-cjs/contracts/index.cjs" },
  { entry: "dist/diagnostics/index.js", outfile: "dist-cjs/diagnostics/index.cjs" },
  { entry: "dist/fault/index.js", outfile: "dist-cjs/fault/index.cjs" },
  { entry: "dist/ledger/index.js", outfile: "dist-cjs/ledger/index.cjs" },
  { entry: "dist/observability/index.js", outfile: "dist-cjs/observability/index.cjs" },
  { entry: "dist/otel/index.js", outfile: "dist-cjs/otel/index.cjs" },
  { entry: "dist/replay/index.js", outfile: "dist-cjs/replay/index.cjs" },
  { entry: "dist/resources/index.js", outfile: "dist-cjs/resources/index.cjs" },
  { entry: "dist/time-policy/index.js", outfile: "dist-cjs/time-policy/index.cjs" },
];

await rm("dist-cjs", { recursive: true, force: true });

for (const target of ENTRIES) {
  await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["@opentelemetry/api"],
    plugins: target.plugins ?? [],
    logLevel: "silent",
  });
}

function isCandidateModule(importer, filename) {
  return importer.replaceAll("\\", "/").endsWith(`/candidates/${filename}`);
}
