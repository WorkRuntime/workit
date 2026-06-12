/**
 * Resource helper subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { bracketLazy, bracketShared, scopeAcquire } from "../../dist/resources/index.js";

test("Given lazy resource unused, acquire and release are not called", async () => {
  let acquired = 0;
  let released = 0;

  const task = bracketLazy(
    async () => {
      acquired++;
      return "resource";
    },
    async (resource) => {
      assert.equal(resource.acquired(), false);
      return "unused";
    },
    async () => {
      released++;
    },
  );

  const result = await run.scope(async (scope) => await scope.spawn(task));

  assert.equal(result, "unused");
  assert.equal(acquired, 0);
  assert.equal(released, 0);
});

test("Given lazy resource used, release runs once with cleanup context", async () => {
  let acquired = 0;
  let released = 0;
  let cleanupTimeout = 0;
  let cleanupSignalSeen = false;

  const task = bracketLazy(
    async () => {
      acquired++;
      return { id: "lazy" };
    },
    async (resource) => {
      const value = await resource.get();
      assert.equal(resource.acquired(), true);
      return value.id;
    },
    async (resource, ctx) => {
      released++;
      cleanupTimeout = ctx.timeoutMs;
      cleanupSignalSeen = ctx.signal instanceof AbortSignal;
      assert.equal(resource.id, "lazy");
    },
    { timeout: 25 },
  );

  const result = await run.scope(async (scope) => await scope.spawn(task));

  assert.equal(result, "lazy");
  assert.equal(acquired, 1);
  assert.equal(released, 1);
  assert.equal(cleanupTimeout, 25);
  assert.equal(cleanupSignalSeen, true);
});

test("Given lazy resource requested concurrently, acquire runs once and cached get returns same resource", async () => {
  let acquired = 0;

  const task = bracketLazy(
    async () => {
      acquired++;
      await sleep(5);
      return { id: acquired };
    },
    async (resource) => {
      const [first, second] = await Promise.all([resource.get(), resource.get()]);
      const third = await resource.get();
      return [first.id, second.id, third.id];
    },
    async () => undefined,
  );

  const result = await run.scope(async (scope) => await scope.spawn(task));

  assert.deepEqual(result, [1, 1, 1]);
  assert.equal(acquired, 1);
});

test("Given lazy acquire failure, bracketLazy propagates the acquire error and does not release", async () => {
  let released = 0;
  const task = bracketLazy(
    async () => {
      throw new Error("lazy acquire failed");
    },
    async (resource) => await resource.get(),
    async () => {
      released++;
    },
  );

  await assert.rejects(
    run.scope(async (scope) => await scope.spawn(task)),
    /lazy acquire failed/,
  );
  assert.equal(released, 0);
});

test("Given lazy resource used then cancelled, task cleanup still releases the resource", async () => {
  let released = 0;
  const task = bracketLazy(
    async () => ({ id: "lazy-cancel" }),
    async (resource, ctx) => {
      await resource.get();
      ctx.scope.cancel({ kind: "manual", tag: "lazy_cancel" });
      await sleep(1_000, ctx.signal);
    },
    async (resource) => {
      released++;
      assert.equal(resource.id, "lazy-cancel");
    },
  );

  await assert.rejects(
    run.scope(async (scope) => {
      await scope.spawn(task, { name: "lazy.cancel" });
    }),
    CancellationError,
  );

  assert.equal(released, 1);
});

test("Given lazy cleanup timeout, existing event surface records task cleanup timeout", async () => {
  const events = [];
  const task = bracketLazy(
    async () => "lazy-timeout",
    async (resource) => {
      await resource.get();
      return "used";
    },
    async () => new Promise(() => undefined),
    { timeout: 5 },
  );

  await run.scope(async (scope) => {
    scope.onEvent((event) => events.push(event));
    return await scope.spawn(task, { name: "lazy.timeout" });
  });

  assert.equal(events.some((event) => event.type === "task:cleanup_timeout" && event.timeoutMs === 5), true);
});

test("Given lazy cleanup failure, existing event surface records task cleanup failure", async () => {
  const events = [];
  const task = bracketLazy(
    async () => "lazy-failure",
    async (resource) => {
      await resource.get();
      return "used";
    },
    async () => {
      throw new Error("release failed");
    },
  );

  await run.scope(async (scope) => {
    scope.onEvent((event) => events.push(event));
    return await scope.spawn(task, { name: "lazy.failure" });
  });

  assert.equal(events.some((event) => event.type === "task:cleanup_failed"), true);
});

test("Given shared resource used by parallel tasks, acquire and release run once", async () => {
  let acquired = 0;
  let released = 0;
  const shared = bracketShared(
    async () => {
      acquired++;
      return { id: acquired };
    },
    async (resource) => {
      await sleep(5);
      return resource.id;
    },
    async () => {
      released++;
    },
  );

  const values = await run.scope(async (scope) => {
    const first = scope.spawn(shared, { name: "shared.first" });
    const second = scope.spawn(shared, { name: "shared.second" });
    return await Promise.all([first, second]);
  });

  assert.deepEqual(values, [1, 1]);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});

test("Given shared resource reused sequentially in one scope, cached resource is returned", async () => {
  let acquired = 0;
  const shared = bracketShared(
    async () => {
      acquired++;
      return { id: acquired };
    },
    async (resource) => resource.id,
    async () => undefined,
  );

  const values = await run.scope(async (scope) => {
    const first = await scope.spawn(shared);
    const second = await scope.spawn(shared);
    return [first, second];
  });

  assert.deepEqual(values, [1, 1]);
  assert.equal(acquired, 1);
});

test("Given shared helper used in separate scopes, each scope owns its own resource", async () => {
  let acquired = 0;
  let released = 0;
  const shared = bracketShared(
    async () => {
      acquired++;
      return { id: acquired };
    },
    async (resource) => resource.id,
    async () => {
      released++;
    },
  );

  const first = await run.scope(async (scope) => await scope.spawn(shared));
  const second = await run.scope(async (scope) => await scope.spawn(shared));

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(acquired, 2);
  assert.equal(released, 2);
});

test("Given shared acquire failure, bracketShared propagates failure and a fresh scope can acquire", async () => {
  let attempts = 0;
  let bodyRuns = 0;
  const shared = bracketShared(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("shared acquire failed");
      return { id: attempts };
    },
    async (resource) => {
      bodyRuns++;
      return resource.id;
    },
    async () => undefined,
  );

  await assert.rejects(
    run.scope(async (scope) => {
      await scope.spawn(shared);
    }),
    /shared acquire failed/,
  );
  const value = await run.scope(async (scope) => await scope.spawn(shared));

  assert.equal(value, 2);
  assert.equal(attempts, 2);
  assert.equal(bodyRuns, 1);
});

test("Given cancellation, shared resource release still runs through scope cleanup", async () => {
  let released = 0;
  const shared = bracketShared(
    async () => ({ id: "shared" }),
    async (_resource, ctx) => {
      ctx.scope.cancel({ kind: "manual", tag: "resource_cancel" });
      await sleep(1_000, ctx.signal);
    },
    async () => {
      released++;
    },
  );

  await assert.rejects(
    run.scope(async (scope) => {
      await scope.spawn(shared, { name: "shared.cancel" });
    }),
    CancellationError,
  );

  assert.equal(released, 1);
});

test("Given scopeAcquire, resource is returned and scope cleanup runs in LIFO order", async () => {
  const released = [];
  const firstResource = { id: "first" };
  const secondResource = { id: "second" };

  const result = await run.scope(async (scope) => {
    const first = scopeAcquire(scope, firstResource, async (resource) => {
      released.push(resource.id);
    });
    const second = scopeAcquire(scope, secondResource, async (resource) => {
      released.push(resource.id);
    });

    assert.equal(first, firstResource);
    assert.equal(second, secondResource);
    return "registered";
  });

  assert.equal(result, "registered");
  assert.deepEqual(released, ["second", "first"]);
});

test("Given scopeAcquire release timeout, existing event surface records cleanup timeout", async () => {
  const events = [];

  await run.scope(async (scope) => {
    scope.onEvent((event) => events.push(event));
    scopeAcquire(scope, "resource", async () => new Promise(() => undefined), { timeout: 5 });
  });

  assert.equal(events.some((event) => event.type === "scope:cleanup_timeout" && event.timeoutMs === 5), true);
});

test("Given scopeAcquire release failure, existing event surface records cleanup failure", async () => {
  const events = [];

  await run.scope(async (scope) => {
    scope.onEvent((event) => events.push(event));
    scopeAcquire(scope, "resource", async () => {
      throw new Error("scope release failed");
    });
  });

  assert.equal(events.some((event) => event.type === "scope:cleanup_failed"), true);
});

test("Given the root import, resource helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("bracketLazy" in root, false);
  assert.equal("bracketShared" in root, false);
  assert.equal("scopeAcquire" in root, false);
});

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
