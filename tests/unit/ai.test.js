/**
 * AI companion subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { CancellationError, ContextBagImpl, group } from "../../dist/index.js";
import {
  BadBatchError,
  OpenAITokens,
  embedAll,
  embedAllBisection,
  streamWithBackpressure,
  transcribeStream,
  wrapAI,
} from "../../dist/ai/index.js";

async function* stream(items) {
  for (const item of items) yield item;
}

test("embedAll uses explicit token counter concurrency error policy retry and timeout", async () => {
  let attempts = 0;
  const budget = { spent: 0, limit: 20, unit: "tokens" };
  const context = new ContextBagImpl().with(OpenAITokens, budget);
  const provider = {
    async embed(input) {
      attempts++;
      if (input === "retry" && attempts === 1) throw new Error("transient");
      if (input === "bad") throw new Error("bad input");
      return [input.length];
    },
  };

  const output = await group(
    async () => embedAll(["retry", "bad"], provider, {
      concurrency: 2,
      onError: "continue",
      countTokens: (input) => input.length,
      retry: 2,
      timeout: 1_000,
    }),
    { context }
  );

  assert.equal(output.mode, "continue");
  assert.deepEqual(output.results, [[5]]);
  assert.equal(output.errors.length, 1);
  assert.equal(context.get(OpenAITokens).spent, 16);
});

test("embedAll uses provider token counter and default fail policy", async () => {
  const budget = { spent: 0, limit: 10, unit: "tokens" };
  const context = new ContextBagImpl().with(OpenAITokens, budget);
  const provider = {
    countTokens: (input) => input.length,
    async embed(input, ctx) {
      assert.equal(ctx.kind, "io");
      return [input.length, input.length + 1];
    },
  };

  const output = await group(
    async () => embedAll(["abc"], provider),
    { context }
  );

  assert.equal(output.mode, "fail");
  assert.deepEqual(output.results, [[3, 4]]);
  assert.equal(context.get(OpenAITokens).spent, 3);
});

test("embedAll does not require a token budget when no counter is available", async () => {
  const output = await embedAll(["plain"], {
    async embed(input) {
      return [input.length];
    },
  });

  assert.equal(output.mode, "fail");
  assert.deepEqual(output.results, [[5]]);
});

test("wrapAI emits success and failure task log events", async () => {
  const events = [];

  await group(async (task) => {
    await task(async (ctx) => {
      ctx.scope.onEvent((event) => events.push(event));
      return await wrapAI("test-provider", async () => "ok")(ctx);
    });
  });

  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        ctx.scope.onEvent((event) => events.push(event));
        return await wrapAI("test-provider", async () => {
          throw "provider down";
        })(ctx);
      });
    }),
    /provider down/
  );

  await assert.rejects(
    group(async (task) => {
      await task(async (ctx) => {
        ctx.scope.onEvent((event) => events.push(event));
        return await wrapAI("test-provider", async () => {
          throw new Error("provider error");
        })(ctx);
      });
    }),
    /provider error/
  );

  assert.ok(events.some((event) => event.message === "ai task started"));
  assert.ok(events.some((event) => event.message === "ai task succeeded"));
  assert.ok(events.some((event) =>
    event.message === "ai task failed" && event.data.fields.error === "provider down"
  ));
  assert.ok(events.some((event) =>
    event.message === "ai task failed" && event.data.fields.error === "provider error"
  ));
});

test("transcribeStream yields provider output for each chunk", async () => {
  const chunks = stream(["a", "b"]);
  const output = [];

  for await (const text of transcribeStream(chunks, {
    async transcribe(input, ctx) {
      assert.equal(ctx.name, "ai.transcribe");
      assert.equal(ctx.kind, "llm");
      return input.toUpperCase();
    },
  })) {
    output.push(text);
  }

  assert.deepEqual(output, ["A", "B"]);
});

test("embedAllBisection splits bad batches and preserves input order", async () => {
  const calls = [];
  const budget = { spent: 0, limit: 100, unit: "tokens" };
  const context = new ContextBagImpl().with(OpenAITokens, budget);
  const provider = {
    async embedBatch(inputs) {
      calls.push([...inputs]);
      if (inputs.includes("bad")) throw new BadBatchError("bad mixed batch");
      return inputs.map((input) => [input.length]);
    },
  };

  const output = await group(
    async () => embedAllBisection(["good", "bad", "ok"], provider, {
      batchSize: 3,
      onError: "continue",
      countTokens: (input) => input.length,
    }),
    { context }
  );

  assert.equal(output.mode, "continue");
  assert.deepEqual(output.results, [[4], [2]]);
  assert.deepEqual(output.errors.map((error) => error.index), [1]);
  assert.equal(output.errors[0].item, "bad");
  assert.equal(output.errors[0].error instanceof BadBatchError, true);
  assert.equal(context.get(OpenAITokens).spent, 9);
  assert.deepEqual(calls, [
    ["good", "bad", "ok"],
    ["good", "bad"],
    ["good"],
    ["bad"],
    ["ok"],
  ]);
});

test("embedAllBisection accepts async iterable inputs", async () => {
  async function* inputs() {
    yield "aa";
    yield "bbb";
  }

  const output = await embedAllBisection(inputs(), {
    async embedBatch(batch) {
      return batch.map((item) => [item.length]);
    },
  }, {
    batchSize: 2,
    onError: "continue",
  });

  assert.equal(output.mode, "continue");
  assert.deepEqual(output.results, [[2], [3]]);
  assert.deepEqual(output.errors, []);
});

test("embedAllBisection sorts multiple isolated item errors by input index", async () => {
  const output = await embedAllBisection(["bad-a", "ok", "bad-b"], {
    async embedBatch(batch) {
      if (batch.some((item) => item.startsWith("bad"))) throw new BadBatchError("mixed batch");
      return batch.map((item) => [item.length]);
    },
  }, {
    batchSize: 3,
    onError: "continue",
  });

  assert.deepEqual(output.results, [[2]]);
  assert.deepEqual(output.errors.map((error) => error.index), [0, 2]);
});

test("embedAllBisection composes retry and timeout policies", async () => {
  let attempts = 0;

  const output = await embedAllBisection(["retry", "ok"], {
    async embedBatch(batch) {
      attempts++;
      if (attempts === 1) throw new Error("transient batch failure");
      return batch.map((item) => [item.length]);
    },
  }, {
    batchSize: 2,
    onError: "continue",
    retry: 2,
    timeout: 1_000,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(output.results, [[5], [2]]);
  assert.deepEqual(output.errors, []);
});

test("embedAllBisection fail mode and validation surface provider errors", async () => {
  await assert.rejects(
    embedAllBisection(["bad"], {
      async embedBatch() {
        throw new BadBatchError("single bad item");
      },
    }),
    /single bad item/
  );

  await assert.rejects(
    embedAllBisection(["a", "b"], {
      async embedBatch() {
        throw new Error("provider down");
      },
    }, { batchSize: 2 }),
    /provider down/
  );

  const mismatch = await embedAllBisection(["a", "b"], {
    async embedBatch() {
      return [[1]];
    },
  }, { batchSize: 2, onError: "continue" });
  assert.equal(mismatch.errors.length, 1);
  assert.match(mismatch.errors[0].error.message, /returned 1 vectors/);

  await assert.rejects(
    embedAllBisection(["a"], {
      async embedBatch() {
        return [[1]];
      },
    }, { batchSize: 0 }),
    /batchSize/
  );
});

test("embedAllBisection preserves cancellation during recursive split", async () => {
  let calls = 0;

  await assert.rejects(
    group(async () => {
      await embedAllBisection(["a", "bad", "c"], {
        async embedBatch() {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new BadBatchError("split me");
        },
      }, {
        batchSize: 3,
        onError: "continue",
        classifyError() {
          if (calls === 1) throw new CancellationError({ kind: "manual", tag: "stop-bisection" });
          return "split";
        },
      });
    }, { name: "bisection-cancel" }),
    CancellationError
  );
});

test("transcribeStream aborts on disconnect and closes the source iterator", async () => {
  const ctrl = new AbortController();
  let closed = false;
  let providerCancelled = false;
  let markSecondStarted;
  const secondStarted = new Promise((resolve) => {
    markSecondStarted = resolve;
  });

  async function* liveAudio() {
    try {
      yield "first";
      yield "second";
    } finally {
      closed = true;
    }
  }

  const iterator = transcribeStream(liveAudio(), {
    async transcribe(input, ctx) {
      if (input === "first") return "FIRST";
      markSecondStarted();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          providerCancelled = true;
          reject(ctx.signal.reason);
        }, { once: true });
      });
      return "SECOND";
    },
  }, { signal: ctrl.signal })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { value: "FIRST", done: false });
  const pending = iterator.next();
  await secondStarted;
  ctrl.abort(new CancellationError({ kind: "manual", tag: "client-disconnect" }));

  await assert.rejects(pending, CancellationError);
  assert.equal(providerCancelled, true);
  assert.equal(closed, true);
});

test("transcribeStream closes source when reading the next chunk fails", async () => {
  const ctrl = new AbortController();
  let closed = false;
  const chunks = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw new Error("audio read failed");
        },
        async return() {
          closed = true;
          return { done: true };
        },
      };
    },
  };

  const iterator = transcribeStream(chunks, {
    async transcribe() {
      return "unreachable";
    },
  }, { signal: ctrl.signal })[Symbol.asyncIterator]();

  await assert.rejects(iterator.next(), /audio read failed/);
  assert.equal(closed, true);
});

test("transcribeStream rejects immediately when the disconnect signal is already aborted", async () => {
  const ctrl = new AbortController();
  ctrl.abort(new CancellationError({ kind: "manual", tag: "already-disconnected" }));

  const iterator = transcribeStream(stream(["unused"]), {
    async transcribe() {
      return "unreachable";
    },
  }, { signal: ctrl.signal })[Symbol.asyncIterator]();

  await assert.rejects(iterator.next(), CancellationError);
});

test("transcribeStream aborts while waiting for the next source chunk", async () => {
  const ctrl = new AbortController();
  let closed = false;
  const chunks = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return await new Promise(() => undefined);
        },
        async return() {
          closed = true;
          return { done: true };
        },
      };
    },
  };

  const iterator = transcribeStream(chunks, {
    async transcribe() {
      return "unreachable";
    },
  }, { signal: ctrl.signal })[Symbol.asyncIterator]();

  const pending = iterator.next();
  ctrl.abort(new CancellationError({ kind: "manual", tag: "chunk-read-aborted" }));

  await assert.rejects(pending, CancellationError);
  assert.equal(closed, true);
});

test("streamWithBackpressure bounds provider work retries failures and closes async sources", async () => {
  let active = 0;
  let maxActive = 0;
  let attempts = 0;
  let closed = false;
  const ctrl = new AbortController();

  async function* source() {
    try {
      yield "a";
      yield "retry";
      yield "b";
    } finally {
      closed = true;
    }
  }

  const output = [];
  for await (const item of streamWithBackpressure(source(), async (input, ctx) => {
    active++;
    maxActive = Math.max(maxActive, active);
    attempts++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(ctx.signal.reason);
      }, { once: true });
    });
    active--;

    if (input === "retry" && attempts < 3) throw new Error("transient stream failure");
    return input.toUpperCase();
  }, {
    concurrency: 2,
    retry: 2,
    timeout: 1_000,
    signal: ctrl.signal,
  })) {
    output.push(item);
  }

  assert.deepEqual(output.sort(), ["A", "B", "RETRY"]);
  assert.ok(maxActive <= 2);
  assert.equal(closed, true);
});

test("streamWithBackpressure observes external abort signals", async () => {
  const ctrl = new AbortController();
  const iterator = streamWithBackpressure(["a", "b"], async (input, ctx) => {
    if (input === "a") return "A";
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(ctx.signal.reason);
      }, { once: true });
    });
    return "B";
  }, {
    concurrency: 1,
    signal: ctrl.signal,
  })[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), { value: "A", done: false });
  const pending = iterator.next();
  ctrl.abort(new CancellationError({ kind: "manual", tag: "stop-stream" }));
  await assert.rejects(pending, CancellationError);
});

test("streamWithBackpressure uses task signals when no external signal is provided", async () => {
  const output = [];

  for await (const item of streamWithBackpressure(["plain"], async (input, ctx) => {
    assert.equal(ctx.signal.aborted, false);
    return input.toUpperCase();
  })) {
    output.push(item);
  }

  assert.deepEqual(output, ["PLAIN"]);
});
