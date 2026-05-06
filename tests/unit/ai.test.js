/**
 * AI companion subpath tests.
 *
 * @author Admilson B. F. Cossa
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { ContextBagImpl, group } from "../../dist/index.js";
import { OpenAITokens, embedAll, transcribeStream, wrapAI } from "../../dist/ai/index.js";

async function* stream(items) {
  for (const item of items) yield item;
}

test("embedAll uses explicit token counter concurrency error policy retry and timeout", async () => {
  let attempts = 0;
  const budget = { spent: 0, limit: 20, unit: "tokens" };
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
    { context: new ContextBagImpl().with(OpenAITokens, budget) }
  );

  assert.equal(output.mode, "continue");
  assert.deepEqual(output.results, [[5]]);
  assert.equal(output.errors.length, 1);
  assert.equal(budget.spent, 16);
});

test("embedAll uses provider token counter and default fail policy", async () => {
  const budget = { spent: 0, limit: 10, unit: "tokens" };
  const provider = {
    countTokens: (input) => input.length,
    async embed(input, ctx) {
      assert.equal(ctx.kind, "io");
      return [input.length, input.length + 1];
    },
  };

  const output = await group(
    async () => embedAll(["abc"], provider),
    { context: new ContextBagImpl().with(OpenAITokens, budget) }
  );

  assert.equal(output.mode, "fail");
  assert.deepEqual(output.results, [[3, 4]]);
  assert.equal(budget.spent, 3);
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
