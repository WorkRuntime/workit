/**
 * Bench 15 -- zero networking imports in the published core bundle.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The production gate `npm run check:no-network` runs over the `src/` tree.
 * This bench reproduces the same property over the *built artifact* -- the
 * exact files a consumer installs from npm -- across the core surface and
 * its non-network subpaths.
 *
 * Subpaths intentionally excluded:
 *   - dist/observability  (opt-in exporter bridge; uses no network either,
 *                          but it's the network *seam* and we don't want to
 *                          tie the article's claim to it staying empty)
 *   - dist/otel           (opt-in OpenTelemetry bridge; uses the user's
 *                          tracer/meter object)
 *   - dist/worker         (uses node:worker_threads, not networking)
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { jsonReplacer } from "./lib/baselines.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
const distRoot = path.join(repoRoot, "dist");

const FORBIDDEN = [
  { name: "import 'node:http'",  pattern: /["']node:http["']/ },
  { name: "import 'node:https'", pattern: /["']node:https["']/ },
  { name: "import 'http'",       pattern: /from\s+["']http["']/ },
  { name: "import 'https'",      pattern: /from\s+["']https["']/ },
  { name: "global fetch(...)",   pattern: /\bfetch\s*\(/ },
];

const EXCLUDED_DIRS = new Set(["observability", "otel", "worker"]);

const result = { bench: "15-core-zero-network", filesScanned: 0, hits: [], excluded: [...EXCLUDED_DIRS] };

async function walk(dir, relRoot = "") {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const rel = relRoot ? `${relRoot}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relRoot === "" && EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(full, rel);
      continue;
    }
    if (!/\.(?:js|cjs|mjs)$/.test(entry.name)) continue;
    result.filesScanned++;
    const text = await readFile(full, "utf8");
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) result.hits.push({ file: rel, kind: name });
    }
  }
}

await walk(distRoot);

result.passed = result.hits.length === 0;

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");

assert.equal(result.hits.length, 0,
  `core network imports leaked into dist/: ${JSON.stringify(result.hits)}`);
assert.ok(result.filesScanned > 0, "expected at least one file to be scanned (dist/ must be built)");
