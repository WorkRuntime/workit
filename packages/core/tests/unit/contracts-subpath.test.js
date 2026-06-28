/**
 * Typed cancellation contract subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import { CancellationError } from "../../dist/index.js";
import {
  cancellable,
  discardCancellation,
  getTaskContract,
  isCancellableTask,
  isShieldedTask,
  shielded,
  typedGroup,
} from "../../dist/contracts/index.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

test("contracts mark cancellable tasks without changing task behavior", async () => {
  const task = cancellable(async () => "ok");

  assert.equal(isCancellableTask(task), true);
  assert.equal(isShieldedTask(task), false);
  assert.deepEqual(getTaskContract(task), { kind: "cancellable" });
  assert.equal(await typedGroup(async (spawn) => await spawn(task)), "ok");
});

test("typedGroup can spawn explicitly shielded work through shielded boundary", async () => {
  const task = shielded(async () => "shielded", { timeout: 100 });
  const result = await typedGroup(async (spawn) => await spawn.shielded(task));

  assert.equal(result, "shielded");
  assert.equal(isShieldedTask(task), true);
  assert.deepEqual(getTaskContract(task), { kind: "shielded", timeout: 100 });
});

test("typedGroup background accepts declared cancellable work", async () => {
  const task = cancellable(async () => "background");
  const result = await typedGroup(async (spawn) => {
    const handle = spawn.background(task);
    return await handle;
  });

  assert.equal(result, "background");
});

test("discardCancellation requires a named reason and records shield metadata", async () => {
  const task = cancellable(async () => "audit");
  const shield = discardCancellation(task, "audit_flush", { timeout: 100 });

  assert.deepEqual(getTaskContract(shield), {
    kind: "shielded",
    timeout: 100,
    discardReason: "audit_flush",
  });
  assert.equal(await typedGroup(async (spawn) => await spawn.shielded(shield)), "audit");
  assert.throws(() => discardCancellation(task, " ", { timeout: 100 }), /non-empty reason/);
});

test("shielded task remains timeout bounded", async () => {
  const task = shielded(async (ctx) => {
    await sleep(1_000, ctx.signal);
    return "never";
  }, { timeout: 5 });

  await assert.rejects(
    typedGroup(async (spawn) => await spawn.shielded(task)),
    CancellationError,
  );
});

test("contracts subpath is not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("cancellable" in root, false);
  assert.equal("typedGroup" in root, false);
  assert.equal("shielded" in root, false);
});
