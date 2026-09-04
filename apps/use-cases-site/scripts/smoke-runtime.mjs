/**
 * Smoke test the local WorkIt runtime API used by the examples site.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRuntimeServer } from "../server/runtime-server.mjs";
import { runtimeFailureLogLine, runtimeFailureResponse } from "../server/runtime-errors.mjs";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const port = String(46_000 + Math.floor(Math.random() * 1_000));
const origin = `http://127.0.0.1:${port}`;
let stderr = "";

const server = spawn(process.execPath, ["server/runtime-server.mjs"], {
  cwd: siteRoot,
  env: {
    ...process.env,
    WORKIT_SITE_RUNTIME_PORT: port,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  assertRuntimeFailureContract();
  await assertRuntimeFailureHttpResponse();
  await waitForHealth();
  await assertVibeCodingRun();
  await assertConversationRun();
  await assertIncidentDecisionGateRun();
  await assertRagRun();
  await assertUnknownExample();
  process.stdout.write("site-runtime-smoke: passed\n");
} finally {
  server.kill();
}

function assertRuntimeFailureContract() {
  const privateError = new Error("private stack detail");
  const response = runtimeFailureResponse();
  const logLine = runtimeFailureLogLine(privateError);

  assert.deepEqual(response, {
    error: "runtime_failed",
    message: "An internal error occurred.",
  });
  assert.equal(JSON.stringify(response).includes(privateError.message), false);
  assert.equal(logLine.includes(privateError.message), true);
}

async function assertRuntimeFailureHttpResponse() {
  const privateError = new Error("private runner detail");
  let logged = "";
  const failingServer = createRuntimeServer({
    runners: {
      "failing-example": async () => {
        throw privateError;
      },
    },
    writeRuntimeError(error) {
      logged += runtimeFailureLogLine(error);
    },
  });

  const failingOrigin = await listenOnEphemeralPort(failingServer);

  try {
    const response = await fetch(`${failingOrigin}/api/examples/failing-example/run`);
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.deepEqual(body, runtimeFailureResponse());
    assert.equal(JSON.stringify(body).includes(privateError.message), false);
    assert.equal(logged.includes(privateError.message), true);
  } finally {
    await closeServer(failingServer);
  }
}

async function assertVibeCodingRun() {
  const result = await getJson("/api/examples/vibe-coding-agent/run");

  assert.equal(result.source, "live-node");
  assert.equal(result.sample, "agent-tree-cancel");
  assertLine(result.events, "task:started tool.search");
  assertLine(result.events, "task:cancelled");
  assertLine(result.receipt, "runtime: @workit/core");
  assertLine(result.receipt, "reason.tag: user_stopped_agent");
  assertLine(result.receipt, "cleanups: browser, code, search");
  assertNoLines(result.events, ["user_redirect", "cancelled_by_user", "leakedTasks"]);
  assertNoLines(result.receipt, ["user_redirect", "cancelled_by_user", "leakedTasks"]);
}

async function assertConversationRun() {
  const result = await getJson("/api/examples/conversation-agent/run");

  assert.equal(result.source, "live-node");
  assert.equal(result.sample, "conversation-agent");
  assertLine(result.events, "task:started llm.stream");
  assertLine(result.events, "task:started tool.search");
  assertLine(result.events, "task:started memory.write");
  assertLine(result.receipt, "runtime: @workit/core");
  assertLine(result.receipt, "tokens: 4");
  assertLine(result.receipt, "toolResults: search:2, repo:clean");
  assertLine(result.receipt, "memoryWrites: 1");
  assertLine(result.receipt, "cleanups: memory, stream, tools");
}

async function assertRagRun() {
  const result = await getJson("/api/examples/rag-pipeline/run");

  assert.equal(result.source, "live-node");
  assert.equal(result.sample, "budget-rag");
  assertLine(result.events, "task:started rag.rerank");
  assertLine(result.events, "task:started rag.synthesize");
  assertLine(result.receipt, "runtime: @workit/core");
  assertLine(result.receipt, "spent: 8");
  assertLine(result.receipt, "limit: 10");
  assertLine(result.receipt, "audit.sources: 2");
}

async function assertIncidentDecisionGateRun() {
  const result = await getJson("/api/examples/incident-decision-gate/run");

  assert.equal(result.source, "live-node");
  assert.equal(result.sample, "incident-decision-gate");
  assertLine(result.events, "quality_rejected -> retry_same_candidate -> accepted");
  assertLine(result.events, "approval: requires_user_input");
  assertLine(result.receipt, "selectedCandidate: grounded-reasoner");
  assertLine(result.receipt, "retryBudget: 1/1");
  assertLine(result.receipt, "productionChangesExecuted: 0");
  assertLine(result.receipt, "credentialsRedacted: true");
  assertNoLines(result.receipt, ["secret-for-"]);
}

async function assertUnknownExample() {
  const response = await fetch(`${origin}/api/examples/missing/run`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error, "unknown_example");
  assert.equal(body.id, "missing");
}

async function waitForHealth() {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Runtime server exited with code ${server.exitCode}. ${stderr}`);
    }

    try {
      const health = await getJson("/api/health");
      assert.equal(health.ok, true);
      assert.equal(health.runtime, "node");
      assert.equal(health.package, "@workit/core");
      return;
    } catch {
      await delay(100);
    }
  }

  throw new Error(`Runtime server did not become healthy on ${origin}. ${stderr}`);
}

async function getJson(path) {
  const response = await fetch(`${origin}${path}`);
  const body = await response.json();

  assert.equal(response.ok, true, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function assertLine(lines, expected) {
  assert.ok(Array.isArray(lines), "Expected a line array.");
  assert.ok(
    lines.some((line) => typeof line === "string" && line.includes(expected)),
    `Missing line containing ${expected}. Received: ${JSON.stringify(lines)}`,
  );
}

function assertNoLines(lines, denied) {
  assert.ok(Array.isArray(lines), "Expected a line array.");
  for (const line of lines) {
    for (const value of denied) {
      assert.equal(
        typeof line === "string" && line.includes(value),
        false,
        `Unexpected line containing ${value}: ${line}`,
      );
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function listenOnEphemeralPort(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("Runtime smoke server did not bind to a TCP port."));
        return;
      }

      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
