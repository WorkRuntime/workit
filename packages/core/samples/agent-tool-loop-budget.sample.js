/**
 * Bounded agent tool-loop sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Demonstrates that a prompt cannot be trusted to stop repeated tool calls.
 * The runtime charges each admitted tool call and cancels the owning agent
 * scope before the fourth tool body can execute.
 */

import assert from "node:assert/strict";
import {
  BudgetExceededError,
  ContextBagImpl,
  group,
} from "@workit/core";
import {
  AgentToolCalls,
  runAgent,
} from "@workit/core/ai";

const REQUESTED_TOOL_CALLS = 6;
const TOOL_CALL_LIMIT = 3;
const TOOL_CALL_UNIT = "tool_calls";

const context = new ContextBagImpl().with(AgentToolCalls, {
  spent: 0,
  limit: TOOL_CALL_LIMIT,
  unit: TOOL_CALL_UNIT,
});

let executedToolCalls = 0;
let observedEvents = [];
let stoppedAtCall;

await assert.rejects(
  group(async () => runAgent(async (agent) => {
    observedEvents = agent.events;

    for (let call = 1; call <= REQUESTED_TOOL_CALLS; call++) {
      try {
        await agent.tool(
          "search_documentation",
          { call },
          async ({ call: admittedCall }) => {
            executedToolCalls++;
            return { admittedCall, result: "same-candidate-set" };
          },
          { toolCalls: 1 },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          stoppedAtCall = call;
        }
        throw error;
      }
    }

    return "unexpected_completion";
  }), { context }),
  (error) => error instanceof BudgetExceededError
    && error.budgetKey === AgentToolCalls.name
    && error.limit === TOOL_CALL_LIMIT
    && error.spent === TOOL_CALL_LIMIT + 1,
);

const finalBudget = context.get(AgentToolCalls);
const eventTypes = observedEvents.map(({ type }) => type);

assert.equal(executedToolCalls, TOOL_CALL_LIMIT);
assert.equal(stoppedAtCall, TOOL_CALL_LIMIT + 1);
assert.deepEqual(finalBudget, {
  spent: TOOL_CALL_LIMIT,
  limit: TOOL_CALL_LIMIT,
  unit: TOOL_CALL_UNIT,
});
assert.equal(eventTypes.filter((type) => type === "agent:tool_started").length, TOOL_CALL_LIMIT + 1);
assert.equal(eventTypes.filter((type) => type === "agent:tool_succeeded").length, TOOL_CALL_LIMIT);
assert.equal(eventTypes.filter((type) => type === "agent:tool_cancelled").length, 1);
assert.equal(eventTypes.at(-1), "agent:failed");

process.stdout.write(`${JSON.stringify({
  sample: "agent-tool-loop-budget",
  requestedToolCalls: REQUESTED_TOOL_CALLS,
  admittedToolCalls: executedToolCalls,
  stoppedBeforeCall: stoppedAtCall,
  budget: finalBudget,
  terminalReason: "budget_exceeded",
  eventTypes,
})}\n`);
