/**
 * Security and contract tests for allowlisted public-data adapters.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const siteRoot = resolve(import.meta.dirname, "..");
const modules = await importAdapters();

test("GitHub importer uses only the curated API origin and no authorization header", async () => {
  let request;
  const scenario = await modules.importGitHubIssuesScenario("vercel/ai", {
    fetcher: async (url, init) => {
      request = { url: String(url), init };
      return jsonResponse([{ number: 42, title: "Tool kept running", html_url: "https://github.com/vercel/ai/issues/42", state: "open", labels: [{ name: "bug" }] }]);
    },
  });
  assert.match(request.url, /^https:\/\/api\.github\.com\/repos\/vercel\/ai\/issues\?/);
  assert.deepEqual(request.init.headers, { accept: "application/json" });
  assert.equal(scenario.source.kind, "github_issues");
  assert.equal(scenario.candidates[0].id, "issue-42");
});

test("GitHub importer rejects repositories outside the allowlist before fetch", async () => {
  let called = false;
  await assert.rejects(
    modules.importGitHubIssuesScenario("attacker/repository", { fetcher: async () => { called = true; } }),
    /allowlist/,
  );
  assert.equal(called, false);
});

test("Open-Meteo importer validates coordinates and maps bounded evidence", async () => {
  let requestUrl;
  const scenario = await modules.importOpenMeteoScenario(-25.97, 32.59, {
    fetcher: async (url) => {
      requestUrl = String(url);
      return jsonResponse({ current: { time: "2026-09-04T10:00", temperature_2m: 27.1, wind_speed_10m: 12.4, precipitation: 0 } });
    },
  });
  assert.match(requestUrl, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.equal(scenario.source.kind, "open_meteo");
  assert.equal(scenario.candidates[0].outcomes[0].evidence.length, 4);
  await assert.rejects(modules.importOpenMeteoScenario(91, 0), /latitude/);
});

test("bounded fetch rejects oversized responses and exposes rate limits without bodies", async () => {
  const oversized = "x".repeat(262_145);
  await assert.rejects(
    modules.fetchBoundedJson(new URL("https://example.invalid"), { fetcher: async () => jsonResponse(oversized) }),
    (error) => error.code === "response_too_large" && !error.message.includes(oversized),
  );
  await assert.rejects(
    modules.fetchBoundedJson(new URL("https://example.invalid"), { fetcher: async () => new Response("secret body", { status: 429, headers: { "x-ratelimit-reset": "100" } }) }),
    (error) => error.code === "rate_limited" && error.retryAt === 100_000 && !error.message.includes("secret body"),
  );
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function importAdapters() {
  const temp = mkdtempSync(join(tmpdir(), "workit-public-data-"));
  const output = join(temp, "adapters.mjs");
  const entry = join(temp, "entry.ts");
  const source = `
    export * from ${JSON.stringify(resolve(siteRoot, "src/labs/public-data/boundedFetch.ts"))};
    export * from ${JSON.stringify(resolve(siteRoot, "src/labs/public-data/githubIssues.ts"))};
    export * from ${JSON.stringify(resolve(siteRoot, "src/labs/public-data/openMeteo.ts"))};
  `;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(entry, source);
  try {
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent" });
    return await import(pathToFileURL(output).href);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
