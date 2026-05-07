/**
 * Executable adoption examples for WorkJS.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * These tests keep public examples honest by running them against the compiled
 * package. Provider calls are explicit fakes at the boundary; WorkJS still uses
 * the real scope, cancellation, budget, run, work, and observability paths.
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import {
  CancellationError,
  ContextBagImpl,
  CostBudget,
  group,
  run,
} from "../../dist/index.js";
import { OpenAITokens, embedAll } from "../../dist/ai/index.js";

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

test("example: cancelling an agent tree aborts tools and still runs cleanup", async () => {
  const cancelled = [];
  const cleanups = [];

  await assert.rejects(
    group(async (task) => {
      const plan = await task(async () => ["tool-a", "tool-b"], {
        name: "agent.plan",
        kind: "llm",
      });

      task.background(async (ctx) => {
        ctx.defer(() => cleanups.push("audit"));
        try {
          await sleep(1_000, ctx.signal);
        } catch (err) {
          if (err instanceof CancellationError) cancelled.push("audit");
          throw err;
        }
      });

      return await task(async () => run.all(plan.map((toolName, index) => async (ctx) => {
        ctx.defer(() => cleanups.push(toolName));
        if (index === 0) {
          await sleep(5, ctx.signal);
          throw new Error("tool failed");
        }
        try {
          await sleep(1_000, ctx.signal);
          return toolName;
        } catch (err) {
          if (err instanceof CancellationError) cancelled.push(toolName);
          throw err;
        }
      })), { name: "agent.tools", kind: "tool" });
    }, { name: "agent.run" }),
    /tool failed/
  );

  assert.deepEqual(cancelled.sort(), ["audit", "tool-b"]);
  assert.deepEqual(cleanups.sort(), ["audit", "tool-a", "tool-b"]);
});

test("example: racing providers returns the winner and aborts losing calls", async () => {
  let abortedLosers = 0;

  const result = await run.race([
    async (ctx) => {
      try {
        await sleep(1_000, ctx.signal);
        return "slow-a";
      } catch (err) {
        if (err instanceof CancellationError) abortedLosers++;
        throw err;
      }
    },
    async (ctx) => {
      await sleep(5, ctx.signal);
      return "winner";
    },
    async (ctx) => {
      try {
        await sleep(1_000, ctx.signal);
        return "slow-b";
      } catch (err) {
        if (err instanceof CancellationError) abortedLosers++;
        throw err;
      }
    },
  ]);

  assert.equal(result, "winner");
  assert.equal(abortedLosers, 2);
});

test("example: budget-capped RAG query composes all helpers without network clients", async () => {
  const budget = { spent: 0, limit: 10, unit: "USD" };
  const context = new ContextBagImpl().with(CostBudget, budget);
  const audits = [];

  const answer = await group(async (task) => {
    const [rewritten, queryVector] = await run.all([
      async (ctx) => {
        ctx.consumeCost(1);
        return "structured concurrency adoption";
      },
      async (ctx) => {
        ctx.consumeCost(2);
        return [0.1, 0.2, 0.3];
      },
    ]);

    const sources = await run.race([
      async (ctx) => {
        await sleep(1, ctx.signal);
        return [`vector:${queryVector.length}`, `keyword:${rewritten}`];
      },
      async (ctx) => {
        await sleep(50, ctx.signal);
        return ["graph:late"];
      },
    ]);

    const reranked = await task(run.hedge(async (ctx) => {
      ctx.consumeCost(2);
      return sources.slice().reverse();
    }, { after: 5, max: 2 }), { name: "rag.rerank", kind: "llm" });

    task.background(async () => {
      audits.push({ rewritten, count: reranked.length });
    });

    return await task(async (ctx) => {
      ctx.consumeCost(3);
      return `answer:${reranked[0]}`;
    }, { name: "rag.synthesize", kind: "llm" });
  }, {
    name: "rag.query",
    context,
  });

  assert.equal(answer, "answer:keyword:structured concurrency adoption");
  assert.deepEqual(audits, [{ rewritten: "structured concurrency adoption", count: 2 }]);
  assert.equal(context.get(CostBudget).spent, 8);
});

test("example: cost overrun stops a composed query before the final provider call", async () => {
  const budget = { spent: 0, limit: 3, unit: "USD" };
  let finalProviderCalled = false;

  await assert.rejects(
    group(async (task) => {
      await run.all([
        async (ctx) => {
          ctx.consumeCost(2);
          return "rewrite";
        },
        async (ctx) => {
          ctx.consumeCost(2);
          return "embed";
        },
      ]);

      return await task(async () => {
        finalProviderCalled = true;
        return "should not run";
      });
    }, {
      context: new ContextBagImpl().with(CostBudget, budget),
    }),
    (err) => err instanceof CancellationError && err.reason.kind === "budget"
  );

  assert.equal(finalProviderCalled, false);
});

test("example: 100k embeddings use bounded concurrency and exact token accounting", async () => {
  const total = 100_000;
  const budget = { spent: 0, limit: total, unit: "tokens" };
  const context = new ContextBagImpl().with(OpenAITokens, budget);
  let active = 0;
  let maxActive = 0;

  function* documents() {
    for (let index = 0; index < total; index++) {
      yield { id: index, tokens: 1 };
    }
  }

  const output = await group(
    async () => embedAll(documents(), {
      countTokens: (doc) => doc.tokens,
      async embed(doc) {
        active++;
        maxActive = Math.max(maxActive, active);
        if (doc.id % 1_000 === 0) await sleep(0);
        active--;
        return [doc.id];
      },
    }, {
      concurrency: 32,
    }),
    { context }
  );

  assert.equal(output.mode, "fail");
  assert.equal(output.results.length, total);
  assert.ok(maxActive <= 32);
  assert.equal(context.get(OpenAITokens).spent, total);
  assert.equal(active, 0);
});

test("example: high-concurrency budget charges land at the exact total", async () => {
  const budget = { spent: 0, limit: 1_000, unit: "credits" };
  const context = new ContextBagImpl().with(CostBudget, budget);

  await group(async () => {
    await run.pool(64, Array.from({ length: 1_000 }, () => async (ctx) => {
      ctx.consumeCost(1);
      return ctx.budgets().find((item) => item.key === CostBudget.name).state.spent;
    }));
  }, {
    context,
  });

  assert.equal(context.get(CostBudget).spent, 1_000);
});
