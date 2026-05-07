/**
 * Performance-sensitive runtime contracts.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { CancellationError, group } from "../../dist/index.js";

test("tasks that never read cancellation signals avoid per-task signal allocation", async () => {
  const originalAbortController = globalThis.AbortController;
  const originalAny = AbortSignal.any;
  let controllers = 0;
  let linkedSignals = 0;

  class CountingAbortController extends originalAbortController {
    constructor() {
      super();
      controllers++;
    }
  }

  globalThis.AbortController = CountingAbortController;
  AbortSignal.any = (signals) => {
    linkedSignals++;
    return originalAny.call(AbortSignal, signals);
  };

  try {
    await group(async (task) => {
      const handles = Array.from({ length: 1_000 }, () => task(async () => 1));
      const values = await Promise.all(handles);
      assert.equal(values.length, 1_000);
    });
  } finally {
    globalThis.AbortController = originalAbortController;
    AbortSignal.any = originalAny;
  }

  assert.ok(controllers <= 2, `allocated ${controllers} AbortController instances`);
  assert.equal(linkedSignals, 0, `linked ${linkedSignals} task signals`);
});

test("lazy task signals still observe parent cancellation after first read", async () => {
  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        ctx.scope.cancel("lazy-parent-cancel");
        await Promise.resolve();
        assert.equal(ctx.signal.aborted, true);
        throw ctx.signal.reason;
      });
    }),
    (err) => err instanceof CancellationError
      && err.reason.kind === "manual"
      && err.reason.tag === "lazy-parent-cancel"
  );
});
