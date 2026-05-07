/**
 * Worker offload tests - verifies the explicit worker-thread execution boundary.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { CancellationError, group } from "../../dist/index.js";
import { offload } from "../../dist/worker/index.js";
import { normalizeWorkerModuleURL } from "../../dist/worker/module-url.js";

test("offload executes only local application-controlled file modules", async () => {
  const moduleURL = new URL("../../samples/cpu-worker.sample-worker.js", import.meta.url);

  const result = await group(async (task) => task(offload(moduleURL, "fibonacci", 10)));

  assert.equal(result.value, 55);
  assert.ok(result.threadId > 0);
});

test("offload rejects inline and remote module URLs before worker import", () => {
  assert.throws(
    () => normalizeWorkerModuleURL(""),
    /must not be empty/
  );
  assert.throws(
    () => offload(new URL("data:text/javascript,export const x = 1"), "x", undefined),
    /local file URL or path/
  );
  assert.throws(
    () => offload("https://example.test/worker.js", "x", undefined),
    /local file URL or path/
  );
  assert.equal(normalizeWorkerModuleURL("./local-worker.js"), "./local-worker.js");
  assert.equal(normalizeWorkerModuleURL("C:\\work\\local-worker.js"), "C:\\work\\local-worker.js");
});

test("offload preserves pre-start and in-flight cancellation", async () => {
  const moduleURL = new URL("../../samples/cpu-worker.sample-worker.js", import.meta.url);
  const preAborted = new AbortController();
  preAborted.abort(new CancellationError({ kind: "manual", tag: "pre-aborted-worker" }));

  await assert.rejects(
    offload(moduleURL, "fibonacci", 10)(createTaskContext(preAborted.signal)),
    (err) => err instanceof CancellationError
      && err.reason.kind === "manual"
      && err.reason.tag === "pre-aborted-worker"
  );

  await withTempWorkerModule(
    "export async function wait(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); return 'late'; }\n",
    async (tempModuleURL) => {
      const controller = new AbortController();
      const promise = offload(tempModuleURL, "wait", 1_000)(createTaskContext(controller.signal));
      setTimeout(() => controller.abort(new CancellationError({ kind: "manual", tag: "in-flight-worker" })), 5);
      await assert.rejects(
        promise,
        (err) => err instanceof CancellationError
          && err.reason.kind === "manual"
          && err.reason.tag === "in-flight-worker"
      );
    }
  );
});

test("offload surfaces worker module failures and exit failures", async () => {
  const moduleURL = new URL("../../samples/cpu-worker.sample-worker.js", import.meta.url);
  await assert.rejects(
    group(async (task) => task(offload(moduleURL, "missingExport", 10))),
    /is not a function/
  );

  await withTempWorkerModule(
    "export function stop() { process.exit(2); }\n",
    async (tempModuleURL) => {
      await assert.rejects(
        group(async (task) => task(offload(tempModuleURL, "stop", undefined))),
        /exit code 2/
      );
    }
  );

  await withTempWorkerModule(
    "export function failPlain() { throw 'plain worker failure'; }\n",
    async (tempModuleURL) => {
      await assert.rejects(
        group(async (task) => task(offload(tempModuleURL, "failPlain", undefined))),
        (err) => err.name === "WorkerTaskError" && err.message === "plain worker failure"
      );
    }
  );
});

test("worker runner rejects unsafe module URLs defensively", async () => {
  const worker = new Worker(new URL("../../dist/worker/runner.js", import.meta.url), {
    workerData: {
      moduleURL: "data:text/javascript,export function run(){ return 'bad'; }",
      exportName: "run",
      input: undefined,
    },
  });

  const reply = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });

  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /local file URL or path/);
});

function createTaskContext(signal) {
  return {
    signal,
    id: "worker-test-task",
    name: "worker-test",
    kind: "cpu",
    attempt: 1,
    scope: {},
    context: {},
    report() {},
    log: { debug() {}, info() {}, warn() {}, error() {} },
    defer() {},
    consume() {},
  };
}

async function withTempWorkerModule(source, body) {
  const dir = await mkdtemp(join(tmpdir(), "workjs-worker-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, source, "utf8");
  try {
    await body(new URL(`file://${file.replaceAll("\\", "/")}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
