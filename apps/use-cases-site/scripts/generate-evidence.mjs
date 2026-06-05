/**
 * Generate evidence snapshots for the WorkIt examples site.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDir, "..");
const repoRoot = resolve(siteRoot, "..", "..");
const outputPath = resolve(siteRoot, "src", "data", "generated", "evidence-snapshots.json");

const samples = [
  { id: "agent-tree-cancel", path: "packages/core/samples/agent-tree-cancel.sample.js" },
  { id: "conversation-agent", path: "packages/core/samples/conversation-agent.sample.js" },
  { id: "race-providers", path: "packages/core/samples/race-providers.sample.js" },
  { id: "budget-rag", path: "packages/core/samples/budget-rag.sample.js" },
];

if (process.platform === "win32") {
  execFileSync("cmd.exe", ["/d", "/s", "/c", "npm run build"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
} else {
  execFileSync("npm", ["run", "build"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
}

const generated = {
  schemaVersion: 1,
  generatedBy: "apps/use-cases-site/scripts/generate-evidence.mjs",
  samples: {},
};

for (const sample of samples) {
  const stdout = execFileSync(process.execPath, [sample.path], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim());
  const source = readFileSync(resolve(repoRoot, sample.path), "utf8");

  generated.samples[sample.id] = {
    path: sample.path,
    result,
    source,
  };
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(generated, null, 2)}\n`);
