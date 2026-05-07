/**
 * High-concurrency budget accounting sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs against the compiled package. It proves bounded `run.pool()` concurrency
 * and exact cooperative budget accounting under many simultaneous tasks.
 */

import assert from "node:assert/strict";
import { ContextBagImpl, CostBudget, group, run } from "../dist/index.js";

const TOTAL = 1_000;
const CONCURRENCY = 64;
const budget = { spent: 0, limit: TOTAL, unit: "credits" };
const context = new ContextBagImpl().with(CostBudget, budget);
let active = 0;
let maxActive = 0;

const results = await group(async () => {
  return await run.pool(CONCURRENCY, Array.from({ length: TOTAL }, (_, index) => async (ctx) => {
    active++;
    maxActive = Math.max(maxActive, active);
    ctx.consumeCost(1);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return index;
  }));
}, {
  context,
});
const finalBudget = context.get(CostBudget);

assert.equal(results.length, TOTAL);
assert.equal(results[0], 0);
assert.equal(results.at(-1), TOTAL - 1);
assert.equal(finalBudget.spent, TOTAL);
assert.ok(maxActive <= CONCURRENCY);
assert.equal(active, 0);

process.stdout.write(`${JSON.stringify({
  sample: "concurrency-budget",
  total: TOTAL,
  concurrency: CONCURRENCY,
  maxActive,
  spent: finalBudget.spent,
})}\n`);
