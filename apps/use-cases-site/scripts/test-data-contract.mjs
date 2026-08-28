/**
 * Verify that the use-cases site displays executable WorkIt data.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { runners } from "../server/runners.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDir, "..");
const repoRoot = resolve(siteRoot, "..", "..");
const snapshotsPath = resolve(siteRoot, "src", "data", "generated", "evidence-snapshots.json");

const exampleContracts = [
  {
    id: "vibe-coding-agent",
    sampleId: "agent-tree-cancel",
    samplePath: "packages/core/samples/agent-tree-cancel.sample.js",
    liveReceipt: [
      "runtime: @workit/core",
      "sample: agent-tree-cancel",
      "cancelled: browser, code, search",
      "reason.kind: manual",
      "reason.tag: user_stopped_agent",
      "cleanups: browser, code, search",
    ],
    liveEvents: ["task:started tool.search", "task:cancelled", "manual/user_stopped_agent"],
  },
  {
    id: "conversation-agent",
    sampleId: "conversation-agent",
    samplePath: "packages/core/samples/conversation-agent.sample.js",
    liveReceipt: [
      "runtime: @workit/core",
      "sample: conversation-agent",
      "tokens: 4",
      "toolResults: search:2, repo:clean",
      "memoryWrites: 1",
      "cleanups: memory, stream, tools",
    ],
    liveEvents: ["task:started llm.stream", "task:started tool.search", "task:started memory.write"],
  },
  {
    id: "provider-fallback",
    sampleId: "race-providers",
    samplePath: "packages/core/samples/race-providers.sample.js",
    liveReceipt: [
      "runtime: @workit/core",
      "sample: race-providers",
      "winner: anthropic",
      "cancelledProviders: gemini, openai",
    ],
    liveEvents: ["task:cancelled", "race_lost"],
  },
  {
    id: "incident-decision-gate",
    sampleId: "incident-decision-gate",
    samplePath: "packages/core/samples/incident-decision-gate.sample.js",
    liveReceipt: [
      "runtime: @workit/core",
      "sample: incident-decision-gate",
      "selectedCandidate: grounded-reasoner",
      "retryBudget: 1/1",
      "approval.reasonCode: production_change_requires_approval",
      "productionChangesExecuted: 0",
      "credentialsRedacted: true",
    ],
    liveEvents: [
      "quality_rejected -> retry_same_candidate -> accepted",
      "approval: requires_user_input",
      "productionChangesExecuted: 0",
    ],
  },
  {
    id: "rag-pipeline",
    sampleId: "budget-rag",
    samplePath: "packages/core/samples/budget-rag.sample.js",
    liveReceipt: [
      "runtime: @workit/core",
      "sample: budget-rag",
      "answer: answer:keyword:structured concurrency",
      "spent: 8",
      "limit: 10",
      "audit.sources: 2",
    ],
    liveEvents: ["task:started rag.rerank", "task:started rag.synthesize"],
  },
];

const deniedDisplayedStrings = [
  "user_redirect",
  "cancelled_by_user",
  "leakedTasks",
  "fabricated",
  "fake",
  "FAANG",
  "hype",
  "moat",
  "killer",
];

async function assertUseCasesMatchExecutableSamples() {
  const snapshots = readJson(snapshotsPath);
  const { useCases } = await importUseCases();

  assert.equal(useCases.length, exampleContracts.length);

  for (const contract of exampleContracts) {
    const snapshot = snapshots.samples[contract.sampleId];
    const useCase = useCases.find((item) => item.id === contract.id);

    assert.ok(snapshot, `Missing generated snapshot ${contract.sampleId}.`);
    assert.ok(useCase, `Missing use case ${contract.id}.`);
    assert.equal(snapshot.path, contract.samplePath);
    assert.equal(useCase.primarySample, contract.samplePath);
    assert.equal(useCase.code, snapshot.source);
    assert.equal(snapshot.source, readFileSync(resolve(repoRoot, contract.samplePath), "utf8"));
    assert.deepEqual(snapshot.result, runSample(contract.samplePath));
    assertUseCaseLinesMatchSnapshot(useCase, snapshot.result);
    assertEvidencePathsExist(useCase);
    assertNoDeniedDisplayedStrings(useCase);
  }
}

async function assertLiveRunnersMatchUseCaseContracts() {
  for (const contract of exampleContracts) {
    const runner = runners[contract.id];

    assert.equal(typeof runner, "function", `Missing live runner for ${contract.id}.`);

    const result = await runner();
    assert.equal(result.sample, contract.sampleId);
    assert.equal(result.code, readFileSync(resolve(repoRoot, contract.samplePath), "utf8"));

    for (const expected of contract.liveReceipt) {
      assertLine(result.receipt, expected, `${contract.id} receipt`);
    }

    for (const expected of contract.liveEvents) {
      assertLine(result.events, expected, `${contract.id} events`);
    }

    assertNoDeniedLines(result.events, `${contract.id} events`);
    assertNoDeniedLines(result.receipt, `${contract.id} receipt`);
  }
}

async function assertRuntimeApiUsesStaticFallbackOnPublicPages() {
  const { runLiveExample, shouldUseLocalRuntime } = await importRuntimeApi();

  assert.equal(shouldUseLocalRuntime({ hostname: "workruntime.github.io" }, true), false);
  assert.equal(shouldUseLocalRuntime({ hostname: "localhost" }, true), true);
  assert.equal(shouldUseLocalRuntime({ hostname: "127.0.0.1" }, true), true);
  assert.equal(shouldUseLocalRuntime({ hostname: "::1" }, true), true);
  assert.equal(shouldUseLocalRuntime({ hostname: "localhost" }, false), false);

  const originalFetch = globalThis.fetch;
  const hadLocation = Object.hasOwn(globalThis, "location");
  const originalLocation = globalThis.location;
  let fetchCalled = false;

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { hostname: "workruntime.github.io" },
  });

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("Static Pages fallback must not call the local runtime API.");
  };

  try {
    assert.equal(await runLiveExample("vibe-coding-agent"), null);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadLocation) {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: originalLocation,
      });
    } else {
      delete globalThis.location;
    }
  }
}

function assertUseCaseLinesMatchSnapshot(useCase, result) {
  const rendered = [
    ...Object.values(useCase.events).flat(),
    ...Object.values(useCase.receipt).flat(),
  ];

  assertLine(rendered, `sample: ${result.sample}`, `${useCase.id} rendered lines`);

  const assertions = SAMPLE_ASSERTIONS[result.sample];
  assert.equal(typeof assertions, "function", `Unhandled sample result ${result.sample}.`);
  assertions(rendered, result, useCase.id);
}

const SAMPLE_ASSERTIONS = Object.freeze({
  "agent-tree-cancel": (rendered, result, id) => {
    assertLine(rendered, `reason.tag: ${result.reason.tag}`, `${id} rendered lines`);
    assertLine(rendered, `cleanups.count: ${result.cleanups.length}`, `${id} rendered lines`);
  },
  "conversation-agent": (rendered, result, id) => {
    assertLine(rendered, `tokens: ${result.tokens.length}`, `${id} rendered lines`);
    assertLine(rendered, `toolResults: ${result.toolResults.join(", ")}`, `${id} rendered lines`);
    assertLine(rendered, `memoryWrites: ${result.memoryWrites}`, `${id} rendered lines`);
  },
  "race-providers": (rendered, result, id) => {
    assertLine(rendered, `winner: ${result.winner}`, `${id} rendered lines`);
    assertLine(rendered, `cancelledProviders.count: ${result.cancelledProviders.length}`, `${id} rendered lines`);
  },
  "incident-decision-gate": (rendered, result, id) => {
    assertLine(rendered, `selectedCandidate: ${result.selection.selectedCandidate}`, `${id} rendered lines`);
    assertLine(rendered, `retryBudget: ${result.selection.retryBudget.spent}/${result.selection.retryBudget.limit}`, `${id} rendered lines`);
    assertLine(rendered, `approval.reasonCode: ${result.approval.reasonCode}`, `${id} rendered lines`);
    assertLine(rendered, `productionChangesExecuted: ${result.approval.productionChangesExecuted}`, `${id} rendered lines`);
  },
  "budget-rag": (rendered, result, id) => {
    assertLine(rendered, `spent: ${result.spent}`, `${id} rendered lines`);
    assertLine(rendered, `audit.sources: ${result.audits[0].sources}`, `${id} rendered lines`);
  },
});

function assertEvidencePathsExist(useCase) {
  for (const item of useCase.evidence) {
    assert.equal(item.status, "tracked");
    assert.ok(readFileSync(resolve(repoRoot, item.path), "utf8"), `Missing evidence path ${item.path}.`);
  }
}

function assertNoDeniedDisplayedStrings(value) {
  const text = JSON.stringify(value);

  for (const denied of deniedDisplayedStrings) {
    assert.equal(text.includes(denied), false, `Displayed use-case data contains ${denied}.`);
  }
}

function assertNoDeniedLines(lines, label) {
  for (const denied of deniedDisplayedStrings) {
    assert.equal(lines.some((line) => line.includes(denied)), false, `${label} contains ${denied}.`);
  }
}

function assertLine(lines, expected, label) {
  assert.ok(Array.isArray(lines), `${label} must be an array.`);
  assert.ok(
    lines.some((line) => typeof line === "string" && line.includes(expected)),
    `${label} missing ${expected}. Received ${JSON.stringify(lines)}.`,
  );
}

function runSample(samplePath) {
  const stdout = execFileSync(process.execPath, [samplePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
  });

  return JSON.parse(stdout.trim());
}

async function importUseCases() {
  return importBundledTypeScript("src/data/useCases.ts", "useCases.mjs");
}

async function importRuntimeApi() {
  return importBundledTypeScript("src/runtimeApi.ts", "runtimeApi.mjs");
}

async function importBundledTypeScript(relativePath, outputName) {
  const tempDir = mkdtempSync(join(tmpdir(), "workit-use-cases-"));
  const outputPath = join(tempDir, outputName);

  try {
    await build({
      entryPoints: [resolve(siteRoot, relativePath)],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: outputPath,
      logLevel: "silent",
    });

    return await import(pathToFileURL(outputPath).href);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

await assertUseCasesMatchExecutableSamples();
await assertLiveRunnersMatchUseCaseContracts();
await assertRuntimeApiUsesStaticFallbackOnPublicPages();
process.stdout.write("site-data-contract: passed\n");
