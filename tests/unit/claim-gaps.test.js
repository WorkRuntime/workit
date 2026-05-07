/**
 * Tracked claim-gap tests from the strict evidence ledger.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationError, group, run, work } from "../../dist/index.js";
import { attachTelemetryExporter, createCardinalitySafeMetricExporter } from "../../dist/observability/index.js";
import { offload } from "../../dist/worker/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("TaskHandle.cancel keeps the first cancellation reason", async () => {
  await assert.rejects(
    group(async (task) => {
      const handle = task(async (ctx) => abortAsRejection(ctx.signal), { name: "cancel-first-wins" });
      handle.cancel("first-reason");
      handle.cancel("second-reason");
      await handle;
    }),
    (err) => err instanceof CancellationError
      && err.reason.kind === "manual"
      && err.reason.tag === "first-reason"
  );
});

test("concurrent scope.cancel calls emit one first-wins reason", async () => {
  const reasons = await group(async (task) => task(async (ctx) => {
    const seen = [];
    ctx.scope.onCancel((reason) => seen.push(reason));
    await Promise.all([
      Promise.resolve().then(() => ctx.scope.cancel("cancel-a")),
      Promise.resolve().then(() => ctx.scope.cancel("cancel-b")),
    ]);
    await sleep(0);
    return seen;
  }));

  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].kind, "manual");
  assert.equal(reasons[0].tag, "cancel-a");
});

test("task kind labels stay cardinality bounded at runtime", async () => {
  const events = [];
  await group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((event) => events.push(event));
    }, { name: "observer" });

    await task(async () => "ok", { name: "bounded-custom", kind: "custom" });

    assert.throws(
      () => task(async () => "bad", { name: "unbounded-kind", kind: "tenant-123" }),
      /task kind/
    );
  });

  assert.ok(events.some((event) => event.type === "task:started" && event.kind === "custom"));

  const metrics = [];
  const exporter = createCardinalitySafeMetricExporter(
    (metric) => metrics.push(metric),
    { allowedLabels: ["taskKind"] }
  );
  await exporter({ name: "workjs_task_total", value: 1, labels: { taskKind: "custom" } });
  await assert.rejects(
    exporter({ name: "workjs_task_total", value: 1, labels: { taskKind: "tenant-123" } }),
    /Metric label "taskKind" value/
  );
});

test("work().stream stays bounded when the consumer is slow", async () => {
  let produced = 0;
  let active = 0;
  let maxActive = 0;
  let consumed = 0;

  async function* source() {
    for (let index = 0; index < 10_000; index++) {
      produced++;
      yield index;
    }
  }

  for await (const _item of work(source())
    .inParallel(8)
    .map(async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(1);
      active--;
      return item;
    })
    .stream()) {
    consumed++;
    await sleep(5);
    if (consumed === 20) break;
  }

  assert.equal(consumed, 20);
  assert.ok(maxActive <= 8);
  assert.ok(produced <= 40, `slow consumer pulled too far ahead: produced=${produced}`);
  assert.equal(active, 0);
});

test("telemetry exporter unsubscribe stops new exports while queued work drains safely", async () => {
  const scope = createScopeHarness();
  const releases = [];
  const exported = [];
  const attachment = attachTelemetryExporter(
    scope,
    async (event) => {
      await new Promise((resolve) => releases.push(resolve));
      exported.push(event.taskId);
    },
    { sampling: { mode: "all" }, queue: { maxItems: 1 } }
  );

  scope.emit(failedEvent("first"));
  scope.emit(failedEvent("second"));
  attachment.unsubscribe();
  scope.emit(failedEvent("after-unsubscribe"));

  assert.equal(attachment.queuedCount(), 1);
  assert.equal(attachment.droppedCount(), 0);

  releases.shift()();
  await flushExporter();
  while (releases.length === 0) await flushExporter();
  releases.shift()();
  await flushExporter();

  assert.deepEqual(exported, ["first", "second"]);
});

test("worker offload rejects class-instance input that would lose methods across structured clone", async () => {
  class WorkerInput {
    constructor(value) {
      this.value = value;
    }
    method() {
      return this.value;
    }
  }

  await withTempWorkerModule(
    "export function inspect(input) { return { value: input.value, methodType: typeof input.method }; }\n",
    async (moduleURL) => {
      await assert.rejects(
        group(async (task) => task(offload(moduleURL, "inspect", new WorkerInput(7)))),
        /plain structured-clone data/
      );
    }
  );
});

test("worker offload preserves typed arrays and shared memory inputs", async () => {
  await withTempWorkerModule(
    [
      "export function inspect(input) {",
      "  const typed = input.typed;",
      "  const shared = new Uint8Array(input.shared);",
      "  return { typedLength: typed.length, typedFirst: typed[0], sharedFirst: shared[0] };",
      "}",
    ].join("\n"),
    async (moduleURL) => {
      const shared = new SharedArrayBuffer(1);
      new Uint8Array(shared)[0] = 9;
      const result = await group(async (task) => task(offload(moduleURL, "inspect", {
        typed: new Uint8Array([3, 4]),
        shared,
      })));

      assert.deepEqual(result, { typedLength: 2, typedFirst: 3, sharedFirst: 9 });
    }
  );
});

test("worker offload input contract accepts structured data and rejects non-data leaves", () => {
  const moduleURL = new URL("../../samples/cpu-worker.sample-worker.js", import.meta.url);
  const cycle = {};
  cycle.self = cycle;
  const nullProto = Object.create(null);
  nullProto.value = 1;

  for (const input of [
    undefined,
    null,
    "text",
    1,
    true,
    1n,
    [1, { nested: "ok" }],
    new Map([["key", { value: 1 }]]),
    new Set([{ value: 1 }]),
    new Date(0),
    /safe/u,
    new ArrayBuffer(1),
    nullProto,
    cycle,
  ]) {
    assert.equal(typeof offload(moduleURL, "fibonacci", input), "function");
  }

  assert.throws(() => offload(moduleURL, "fibonacci", () => undefined), /plain structured-clone data/);
  assert.throws(() => offload(moduleURL, "fibonacci", Symbol("worker")), /plain structured-clone data/);
  assert.throws(() => offload(moduleURL, "fibonacci", { fn() {} }), /plain structured-clone data/);
});

test("worker cancellation wins over a later worker exit", async () => {
  await withTempWorkerModule(
    "export async function exitSoon() { setTimeout(() => process.exit(2), 50); await new Promise(() => undefined); }\n",
    async (moduleURL) => {
      await assert.rejects(
        group(async (task) => {
          const handle = task(offload(moduleURL, "exitSoon", undefined));
          await sleep(5);
          handle.cancel("cancel-before-exit");
          await handle;
        }),
        (err) => err instanceof CancellationError
          && err.reason.kind === "manual"
          && err.reason.tag === "cancel-before-exit"
      );
    }
  );
});

test("run.race surfaces a synchronously rejected candidate", async () => {
  await assert.rejects(
    group(async (task) => task(async () => run.race([
      async () => {
        throw new Error("sync-race-rejection");
      },
      async (ctx) => {
        await sleep(50, ctx.signal);
        return "late";
      },
    ]))),
    /sync-race-rejection/
  );
});

test("deadline cancellation reason remains non-negative under clock rollback", async () => {
  const originalNow = Date.now;
  let observedReason;

  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        const frozen = originalNow() - 10_000;
        Date.now = () => frozen;
        try {
          await abortAsRejection(ctx.signal);
        } catch (err) {
          if (err instanceof CancellationError) observedReason = err.reason;
          throw err;
        } finally {
          Date.now = originalNow;
        }
      });
    }, { deadline: 5 }),
    CancellationError
  );

  Date.now = originalNow;
  assert.equal(observedReason.kind, "deadline");
  assert.ok(observedReason.elapsedMs >= 0);
});

function abortAsRejection(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function createScopeHarness() {
  const handlers = new Set();
  return {
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
  };
}

function failedEvent(taskId) {
  return {
    type: "task:failed",
    taskId,
    error: new Error(`failed:${taskId}`),
    durationMs: 1,
    at: Date.now(),
  };
}

async function flushExporter() {
  await sleep(0);
}

async function withTempWorkerModule(source, body) {
  const dir = await mkdtemp(join(tmpdir(), "workjs-claim-worker-"));
  const file = join(dir, "worker.mjs");
  await writeFile(file, source, "utf8");
  try {
    await body(new URL(`file://${file.replaceAll("\\", "/")}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
