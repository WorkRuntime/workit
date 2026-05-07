/**
 * CommonJS compatibility build for Node consumers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The source of truth remains the ESM TypeScript build in `dist/`. This script
 * creates explicit CommonJS entry bundles for consumers that still use
 * `require("@workjs/core")`.
 */

import { rm } from "node:fs/promises";
import { build } from "esbuild";

const ENTRIES = [
  { entry: "dist/index.js", outfile: "dist-cjs/index.cjs" },
  { entry: "dist/ai/index.js", outfile: "dist-cjs/ai/index.cjs" },
  { entry: "dist/channel/index.js", outfile: "dist-cjs/channel/index.cjs" },
  { entry: "dist/diagnostics/index.js", outfile: "dist-cjs/diagnostics/index.cjs" },
  { entry: "dist/observability/index.js", outfile: "dist-cjs/observability/index.cjs" },
  { entry: "dist/otel/index.js", outfile: "dist-cjs/otel/index.cjs" },
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
    logLevel: "silent",
  });
}
