/**
 * Static core network-import check.
 *
 * @author Admilson B. F. Cossa
 *
 * WorkJS core must remain local-first. This script fails verification if source
 * code imports Node networking modules or calls global fetch from the core
 * package. Remote exporters belong in opt-in companion packages.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const FORBIDDEN = [
  /\bfrom\s+["']node:http["']/,
  /\bfrom\s+["']node:https["']/,
  /\bfrom\s+["']http["']/,
  /\bfrom\s+["']https["']/,
  /\bfetch\s*\(/,
];

const failures = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!/\.[cm]?ts$|\.js$/.test(entry.name)) continue;
    const text = await readFile(path, "utf8");
    if (FORBIDDEN.some((pattern) => pattern.test(text))) failures.push(path);
  }
}

await walk(ROOT);

if (failures.length > 0) {
  console.error("Forbidden network usage in core source:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
