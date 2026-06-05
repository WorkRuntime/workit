/**
 * Activity boundary subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationError, group } from "../../dist/index.js";
import {
  ActivityConflictError,
  ActivityNotRunnableError,
  ActivitySerializationError,
  createFileActivityStore,
  createMemoryActivityStore,
  runActivity,
} from "../../dist/activity/index.js";

test("Given completed activity, repeated execution returns stored result without rerunning body", async () => {
  const store = createMemoryActivityStore();
  let runs = 0;
  const spec = { activityId: "activity-complete", input: { userId: "u1" } };

  const first = await group(async (task) => task(runActivity(store, spec, async () => {
    runs++;
    return { ok: true };
  }, { clock: () => 10 })));
  const second = await group(async (task) => task(runActivity(store, spec, async () => {
    runs++;
    return { ok: false };
  }, { clock: () => 20 })));
  const record = await store.get("activity-complete");

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(runs, 1);
  assert.equal(record.status, "completed");
  assert.equal(record.completedAt, 10);
});

test("Given file activity store, completed activity replays after restart without rerunning body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-activity-"));

  try {
    const spec = { activityId: "activity-file-restart", input: { requestId: "r1" } };
    let runs = 0;

    const first = await group(async (task) => task(runActivity(
      createFileActivityStore({ dir }),
      spec,
      async () => {
        runs++;
        return "persisted-result";
      },
      { clock: () => 10 },
    )));
    const second = await group(async (task) => task(runActivity(
      createFileActivityStore({ dir }),
      spec,
      async () => {
        runs++;
        return "unexpected";
      },
      { clock: () => 20 },
    )));
    const record = await createFileActivityStore({ dir }).get(spec.activityId);

    assert.equal(first, "persisted-result");
    assert.equal(second, "persisted-result");
    assert.equal(runs, 1);
    assert.equal(record.status, "completed");
    assert.equal(record.completedAt, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given file activity store, restart preserves started terminal and conflict contracts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-activity-"));

  try {
    const store = createFileActivityStore({ dir });
    assert.equal(await store.get("activity-file-missing"), undefined);
    await assert.rejects(
      store.finish(makeStartedRecord("activity-file-missing", "hash")),
      ActivityConflictError,
    );

    const started = makeStartedRecord("activity-file-started", "hash");
    assert.equal((await store.start(started)).status, "started");
    assert.equal((await createFileActivityStore({ dir }).start(started)).status, "existing");

    await assert.rejects(
      group(async (task) => task(runActivity(
        createFileActivityStore({ dir }),
        { activityId: "activity-file-started", input: "different" },
        async () => "unexpected",
      ))),
      ActivityConflictError,
    );

    await store.finish({
      ...started,
      status: "completed",
      completedAt: 2,
      updatedAt: 2,
      result: "done",
    });

    await assert.rejects(
      createFileActivityStore({ dir }).finish({
        ...started,
        status: "completed",
        completedAt: 3,
        updatedAt: 3,
        result: "overwritten",
      }),
      ActivityNotRunnableError,
    );
    assert.equal((await createFileActivityStore({ dir }).get(started.activityId)).result, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given file activity store filesystem errors, store operations fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-activity-"));

  try {
    const activityId = "activity-file-error";
    const recordPath = join(dir, `${Buffer.from(activityId, "utf8").toString("base64url")}.json`);
    await mkdir(recordPath);
    const store = createFileActivityStore({ dir });

    await assert.rejects(
      store.start(makeStartedRecord(activityId, "hash")),
      (error) => typeof error === "object" && error !== null && error.code === "EISDIR",
    );
    await assert.rejects(
      store.get(activityId),
      (error) => typeof error === "object" && error !== null && error.code === "EISDIR",
    );

    await assert.rejects(
      store.start(makeStartedRecord("x".repeat(512), "hash")),
      (error) =>
        typeof error === "object"
        && error !== null
        && typeof error.code === "string"
        && error.code !== "EEXIST",
    );

    const corruptId = "activity-corrupt-json";
    await writeFile(
      join(dir, `${Buffer.from(corruptId, "utf8").toString("base64url")}.json`),
      "{not-json",
      "utf8",
    );
    await assert.rejects(store.start(makeStartedRecord(corruptId, "hash")), SyntaxError);
    await assert.rejects(store.get(corruptId), SyntaxError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given same activity id with different input, activity boundary rejects the conflict", async () => {
  const store = createMemoryActivityStore();

  await group(async (task) => task(runActivity(
    store,
    { activityId: "activity-conflict", input: { page: 1 } },
    async () => "first",
  )));

  await assert.rejects(
    group(async (task) => task(runActivity(
      store,
      { activityId: "activity-conflict", input: { page: 2 } },
      async () => "second",
    ))),
    ActivityConflictError,
  );
});

test("Given existing started activity, boundary refuses implicit replay", async () => {
  const store = createMemoryActivityStore();
  await store.start(makeStartedRecord("activity-started-conflict", "hash"));

  await assert.rejects(
    group(async (task) => task(runActivity(
      store,
      { activityId: "activity-started-conflict", input: "input" },
      async () => "unexpected",
    ))),
    ActivityConflictError,
  );

  await assert.rejects(
    group(async (task) => task(runActivity(createExistingStartedStore(), {
      activityId: "activity-started-same",
      input: "input",
    }, async () => "unexpected"))),
    ActivityNotRunnableError,
  );
});

test("Given failed activity body, boundary persists safe error evidence", async () => {
  const store = createMemoryActivityStore();

  await assert.rejects(
    group(async (task) => task(runActivity(
      store,
      { activityId: "activity-failed", input: "x" },
      async () => {
        throw new Error("provider unavailable");
      },
      { clock: () => 30 },
    ))),
    /provider unavailable/,
  );
  const record = await store.get("activity-failed");

  assert.equal(record.status, "failed");
  assert.equal(record.error.name, "Error");
  assert.equal(record.failedAt, 30);
});

test("Given primitive activity failure, boundary persists safe primitive error evidence", async () => {
  const store = createMemoryActivityStore();

  await assert.rejects(
    group(async (task) => task(runActivity(
      store,
      { activityId: "activity-primitive-failed", input: "x" },
      async () => {
        throw "provider-offline";
      },
    ))),
    (error) => error === "provider-offline",
  );
  const record = await store.get("activity-primitive-failed");

  assert.equal(record.status, "failed");
  assert.deepEqual(record.error, { name: "string", message: "provider-offline" });
});

test("Given completed activity record, memory store refuses terminal overwrite", async () => {
  const store = createMemoryActivityStore();
  const started = makeStartedRecord("activity-terminal", "hash");
  await store.start(started);

  await store.finish({
    ...started,
    status: "completed",
    completedAt: 2,
    updatedAt: 2,
    result: "first",
  });

  await assert.rejects(
    store.finish({
      ...started,
      status: "completed",
      completedAt: 3,
      updatedAt: 3,
      result: "second",
    }),
    ActivityNotRunnableError,
  );

  assert.equal((await store.get("activity-terminal")).result, "first");
});

test("Given Date activity input, boundary canonicalizes the JSON value for replay", async () => {
  const store = createMemoryActivityStore();
  const firstInput = { at: new Date("2026-01-01T00:00:00.000Z") };
  const secondInput = { at: new Date("2026-01-01T00:00:00.000Z") };
  let runs = 0;

  const first = await group(async (task) => task(runActivity(
    store,
    { activityId: "activity-date", input: firstInput },
    async () => {
      runs++;
      return "date-ok";
    },
  )));
  const second = await group(async (task) => task(runActivity(
    store,
    { activityId: "activity-date", input: secondInput },
    async () => {
      runs++;
      return "unexpected";
    },
  )));

  assert.equal(first, "date-ok");
  assert.equal(second, "date-ok");
  assert.equal(runs, 1);
});

test("Given array activity input, boundary canonicalizes nested JSON values", async () => {
  const store = createMemoryActivityStore();
  let runs = 0;

  const first = await group(async (task) => task(runActivity(
    store,
    { activityId: "activity-array", input: [{ item: 1 }, { item: 2 }] },
    async () => {
      runs++;
      return "array-ok";
    },
  )));
  const second = await group(async (task) => task(runActivity(
    store,
    { activityId: "activity-array", input: [{ item: 1 }, { item: 2 }] },
    async () => {
      runs++;
      return "unexpected";
    },
  )));

  assert.equal(first, "array-ok");
  assert.equal(second, "array-ok");
  assert.equal(runs, 1);
});

test("Given object input with reordered keys, boundary canonicalizes input for replay", async () => {
  const store = createMemoryActivityStore();
  let runs = 0;

  const first = await group(async (task) => task(runActivity(
    store,
    { activityId: "activity-key-order", input: { z: 1, a: { c: 3, b: 2 } } },
    async () => {
      runs++;
      return "key-order-ok";
    },
  )));
  const second = await group(async (task) => task(runActivity(
    store,
    { activityId: "activity-key-order", input: { a: { b: 2, c: 3 }, z: 1 } },
    async () => {
      runs++;
      return "unexpected";
    },
  )));

  assert.equal(first, "key-order-ok");
  assert.equal(second, "key-order-ok");
  assert.equal(runs, 1);
});

test("Given path-like activity id, file store writes a single encoded record inside the store directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-activity-"));

  try {
    const activityId = "../tenant/../../secret?x=1";
    const store = createFileActivityStore({ dir });

    await group(async (task) => task(runActivity(
      store,
      { activityId, input: { requestId: "r1" } },
      async () => "safe-file-name",
    )));

    const files = await readdir(dir);
    const record = await store.get(activityId);

    assert.equal(files.length, 1);
    assert.match(files[0], /^[A-Za-z0-9_-]+\.json$/);
    assert.equal(files[0].includes(".."), false);
    assert.equal(files[0].includes("/"), false);
    assert.equal(record.status, "completed");
    assert.equal(record.result, "safe-file-name");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given cancelled activity body, boundary persists typed cancellation reason", async () => {
  const store = createMemoryActivityStore();

  await assert.rejects(
    group(async (task) => {
      const handle = task(runActivity(
        store,
        { activityId: "activity-cancelled", input: "x" },
        async (ctx) => sleep(50, ctx.signal),
        { clock: () => 40 },
      ));
      await sleep(1);
      handle.cancel({ kind: "manual", tag: "activity_test" });
      await handle;
    }),
    CancellationError,
  );
  const record = await store.get("activity-cancelled");

  assert.equal(record.status, "cancelled");
  assert.deepEqual(record.cancelReason, { kind: "manual", tag: "activity_test" });
  assert.equal(record.cancelledAt, 40);
});

test("Given non-serializable activity input, boundary rejects before claiming the store", () => {
  let starts = 0;
  const cyclic = {};
  cyclic.self = cyclic;
  const store = {
    async start(record) {
      starts++;
      return { status: "started", record };
    },
    async finish(record) {
      return record;
    },
    async get() {
      return undefined;
    },
  };

  assert.throws(
    () => runActivity(store, { activityId: "activity-cyclic", input: cyclic }, async () => "bad"),
    ActivitySerializationError,
  );
  assert.throws(
    () => runActivity(store, { activityId: "activity-bigint", input: { value: 1n } }, async () => "bad"),
    ActivitySerializationError,
  );
  assert.throws(
    () => runActivity(store, { activityId: "activity-undefined", input: undefined }, async () => "bad"),
    ActivitySerializationError,
  );
  assert.throws(
    () => runActivity(store, { activityId: "activity-nan", input: { value: Number.NaN } }, async () => "bad"),
    ActivitySerializationError,
  );
  assert.throws(
    () => runActivity(store, { activityId: "activity-function", input: { value: () => "bad" } }, async () => "bad"),
    ActivitySerializationError,
  );
  assert.throws(
    () => runActivity(store, { activityId: "activity-symbol", input: { value: Symbol("bad") } }, async () => "bad"),
    ActivitySerializationError,
  );
  assert.equal(starts, 0);
});

test("Given memory activity store retention, oldest records are evicted", async () => {
  const store = createMemoryActivityStore({ maxRecords: 1 });

  await store.start(makeStartedRecord("activity-old", "old"));
  await store.start(makeStartedRecord("activity-new", "new"));

  assert.equal(await store.get("activity-old"), undefined);
  assert.equal((await store.get("activity-new")).activityId, "activity-new");
});

test("Given invalid activity contracts, constructors reject at the boundary", async () => {
  assert.throws(() => createMemoryActivityStore({ maxRecords: 0 }), /maxRecords/);
  assert.throws(() => createFileActivityStore({ dir: "" }), /dir/);

  await assert.rejects(
    group(async (task) => task(runActivity(
      createMemoryActivityStore(),
      { activityId: "", input: "x" },
      async () => "bad",
    ))),
    /activityId/,
  );

  await assert.rejects(
    createMemoryActivityStore().finish(makeStartedRecord("activity-missing", "hash")),
    ActivityConflictError,
  );
});

test("Given the root import, activity helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("createMemoryActivityStore" in root, false);
  assert.equal("createFileActivityStore" in root, false);
  assert.equal("runActivity" in root, false);
  assert.equal("ActivityConflictError" in root, false);
  assert.equal("ActivityNotRunnableError" in root, false);
  assert.equal("ActivitySerializationError" in root, false);
});

function makeStartedRecord(activityId, inputHash) {
  return {
    version: "workit.activity.v1",
    activityId,
    inputHash,
    status: "started",
    startedAt: 1,
    updatedAt: 1,
  };
}

function createExistingStartedStore() {
  return {
    async start(record) {
      return { status: "existing", record };
    },
    async finish(record) {
      return record;
    },
    async get() {
      return undefined;
    },
  };
}

function sleep(ms, signal) {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
