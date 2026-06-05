/**
 * Bench 13 -- budget atomicity, owning-scope cancel, snapshot immutability.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Three scenarios:
 *
 *   A. atomic_concurrent_charges
 *      100 sibling tasks each consume 0.01 from a 1.00 CostBudget. Final spent
 *      must be exactly 1.00 with no double-charge or lost-update.
 *
 *   B. owning_scope_cancellation_at_depth
 *      A budget is set at scope depth 0. A nested chain spawns a task at
 *      depth 5. That deep task tries to consume an amount that exceeds the
 *      budget. The scope at depth 0 (the OWNER of the budget) must be the one
 *      to cancel with reason kind "budget".
 *
 *   C. caller_object_immutability
 *      The plain object passed into run.context.with(CostBudget, {...}) is
 *      never mutated by the engine. After charges, the CALLER's reference is
 *      still { spent: 0, ... }.
 */

import assert from "node:assert/strict";
import { CancellationError, ContextBagImpl, CostBudget, group, run } from "../../dist/index.js";
import { makeClock, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "13-budget-atomicity-and-cancel" };

// --- A -- atomic concurrent charges --------------------------------------
{
  const N = 100;
  const PER = 0.01;
  const callerBudget = { spent: 0, limit: 1.0, unit: "USD" };
  const ctx = new ContextBagImpl().with(CostBudget, callerBudget);

  await group(async (task) => {
    const handles = [];
    for (let i = 0; i < N; i++) {
      handles.push(task(async (c) => { c.consumeCost(PER); }, { name: `charge-${i}` }));
    }
    await Promise.all(handles);
  }, { context: ctx });

  const liveBudget = ctx.get(CostBudget);
  result.A_atomic_concurrent_charges = {
    siblings: N,
    perCharge: PER,
    finalSpent: liveBudget.spent,
    expectedSpent: N * PER,
    callerObjectSpentAfter: callerBudget.spent,
  };
  assert.ok(Math.abs(liveBudget.spent - N * PER) < 1e-9,
    `expected exactly ${N * PER}, got ${liveBudget.spent}`);
}

// --- B -- owning-scope cancellation at depth -----------------------------
{
  const clock = makeClock();
  const callerBudget = { spent: 0, limit: 1.0, unit: "USD" };
  const ctx = new ContextBagImpl().with(CostBudget, callerBudget);

  let outerCancelKind = null;
  let outerSettledAt = -1;
  let chargeAttemptedAtDepth = -1;

  try {
    await group(async (taskD0) => {                         // depth 0 -- OWNS budget
      await taskD0(async () => {
        await group(async (taskD1) => {                     // depth 1
          await taskD1(async () => {
            await group(async (taskD2) => {                 // depth 2
              await taskD2(async () => {
                await group(async (taskD3) => {             // depth 3
                  await taskD3(async () => {
                    await group(async (taskD4) => {         // depth 4
                      await taskD4(async (cD5) => {         // depth 5
                        chargeAttemptedAtDepth = 5;
                        cD5.consumeCost(2.0);                // exceeds 1.0 limit
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    }, { context: ctx });
  } catch (err) {
    outerSettledAt = clock.t();
    if (err instanceof CancellationError) outerCancelKind = err.reason.kind;
  }

  result.B_owning_scope_cancel = {
    chargeAttemptedAtDepth,
    outerSettledAt,
    outerCancelKind,
  };
  assert.equal(outerCancelKind, "budget", "owning scope must cancel with kind='budget'");
  assert.equal(chargeAttemptedAtDepth, 5);
}

// --- C -- caller object immutability -------------------------------------
{
  const callerBudget = { spent: 0, limit: 1.0, unit: "USD" };
  const ctx = new ContextBagImpl().with(CostBudget, callerBudget);

  await group(async (task) => {
    await task(async (c) => { c.consumeCost(0.25); });
    await task(async (c) => { c.consumeCost(0.25); });
  }, { context: ctx });

  const liveBudget = ctx.get(CostBudget);
  result.C_caller_immutability = {
    callerSpentAfter: callerBudget.spent,
    liveSpentAfter: liveBudget.spent,
    callerLimitAfter: callerBudget.limit,
  };
  assert.equal(callerBudget.spent, 0, "caller's input object must not be mutated");
  assert.ok(Math.abs(liveBudget.spent - 0.5) < 1e-9, "live snapshot must reflect the actual spend");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
