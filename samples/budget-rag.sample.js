/**
 * Budget-capped RAG sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Composes rewrite, embedding, source race, hedged reranking, synthesis, and
 * audit background work under one cost budget.
 */

import assert from "node:assert/strict";
import { ContextBagImpl, CostBudget, group, run } from "../dist/index.js";

const budget = { spent: 0, limit: 10, unit: "USD" };
const context = new ContextBagImpl().with(CostBudget, budget);
const audits = [];

const answer = await group(async (task) => {
  const [rewritten, queryVector] = await run.all([
    async (ctx) => {
      ctx.consumeCost(1);
      return "structured concurrency";
    },
    async (ctx) => {
      ctx.consumeCost(2);
      return [0.1, 0.2, 0.3];
    },
  ]);

  const sources = await run.race([
    async (ctx) => {
      await sleep(2, ctx.signal);
      return [`vector:${queryVector.length}`, `keyword:${rewritten}`];
    },
    async (ctx) => {
      await sleep(40, ctx.signal);
      return ["graph:late"];
    },
  ]);

  const reranked = await task(run.hedge(async (ctx) => {
    ctx.consumeCost(2);
    return sources.slice().reverse();
  }, { after: "5ms", max: 2 }), { name: "rag.rerank", kind: "llm" });

  task.background(async () => {
    audits.push({ rewritten, sources: reranked.length });
  });

  return await task(async (ctx) => {
    ctx.consumeCost(3);
    return `answer:${reranked[0]}`;
  }, { name: "rag.synthesize", kind: "llm" });
}, {
  name: "rag.query",
  context,
});
const finalBudget = context.get(CostBudget);

assert.equal(answer, "answer:keyword:structured concurrency");
assert.equal(finalBudget.spent, 8);
assert.deepEqual(audits, [{ rewritten: "structured concurrency", sources: 2 }]);

process.stdout.write(`${JSON.stringify({
  sample: "budget-rag",
  answer,
  spent: finalBudget.spent,
  limit: finalBudget.limit,
  audits,
})}\n`);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
