/**
 * Bad-batch bisection embedding sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Demonstrates isolating one provider-rejected document without losing the
 * successful items from the same original batch.
 */

import { ContextBagImpl, group } from "../dist/index.js";
import { BadBatchError, OpenAITokens, embedAllBisection } from "../dist/ai/index.js";

const calls = [];
const tokenBudget = { spent: 0, limit: 100, unit: "tokens" };
const context = new ContextBagImpl().with(OpenAITokens, tokenBudget);

const result = await group(
  async () => embedAllBisection(["alpha", "bad-doc", "gamma"], {
    async embedBatch(inputs) {
      calls.push([...inputs]);
      if (inputs.includes("bad-doc")) throw new BadBatchError("provider rejected mixed batch");
      return inputs.map((input) => [input.length]);
    },
  }, {
    batchSize: 3,
    onError: "continue",
    countTokens: (input) => input.length,
  }),
  { context }
);
const finalBudget = context.get(OpenAITokens);

console.log(JSON.stringify({
  sample: "embed-bisection",
  vectors: result.results,
  errorIndexes: result.errors.map((error) => error.index),
  calls,
  tokensSpent: finalBudget.spent,
}));
