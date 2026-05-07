/**
 * 100K embeddings sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs a provider-neutral fake embedding workload with bounded concurrency and
 * token budget accounting. No network provider is imported.
 */

import assert from "node:assert/strict";
import { ContextBagImpl, group } from "../dist/index.js";
import { OpenAITokens, embedAll } from "../dist/ai/index.js";

const TOTAL = 100_000;
const CONCURRENCY = 32;
const budget = { spent: 0, limit: TOTAL, unit: "tokens" };
const context = new ContextBagImpl().with(OpenAITokens, budget);
let active = 0;
let maxActive = 0;

function* documents() {
  for (let index = 0; index < TOTAL; index++) {
    yield { id: index, tokens: 1 };
  }
}

const output = await group(
  async () => embedAll(documents(), {
    countTokens: (doc) => doc.tokens,
    async embed(doc) {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return [doc.id];
    },
  }, {
    concurrency: CONCURRENCY,
  }),
  { context }
);
const finalBudget = context.get(OpenAITokens);

assert.equal(output.mode, "fail");
assert.equal(output.results.length, TOTAL);
assert.equal(finalBudget.spent, TOTAL);
assert.ok(maxActive <= CONCURRENCY);

process.stdout.write(`${JSON.stringify({
  sample: "embed-100k",
  total: TOTAL,
  embedded: output.results.length,
  concurrency: CONCURRENCY,
  maxActive,
  tokensSpent: finalBudget.spent,
})}\n`);
