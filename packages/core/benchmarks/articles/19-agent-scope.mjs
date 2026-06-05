/**
 * Bench 19 -- runAgent / AgentScope contract.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Five scenarios prove the agent loop's runtime contract:
 *
 *   A. tool_events             -- every agent.tool() call brackets the body with
 *                                replayable started/succeeded events; agentId
 *                                stays stable; seq is sequential; `at` is
 *                                monotonically non-decreasing.
 *   B. tool_calls_budget       -- AgentToolCalls is charged exactly once per
 *                                call; reaching the cap rejects with
 *                                BudgetExceededError tagged with the budget
 *                                key.
 *   C. tokens_budget           -- OpenAITokens is charged via { tokens: N };
 *                                final spent equals the sum of the calls.
 *   D. parent_cancel           -- when the parent scope cancels mid-tool, the
 *                                tool body's ctx.signal aborts and the
 *                                outer settles as CancellationError with the
 *                                parent's reason.
 *   E. replayable_log          -- the events array on AgentRunResult is a
 *                                complete, ordered, type-discriminated trace
 *                                of the run.
 */

import assert from "node:assert/strict";
import {
  BudgetExceededError,
  CancellationError,
  run,
} from "../../dist/index.js";
import {
  AgentToolCalls,
  OpenAITokens,
  runAgent,
} from "../../dist/ai/index.js";
import { jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "19-agent-scope" };

// --- A -- tool events bracket execution ----------------------------------
{
  const r = await runAgent(async (agent) => {
    const v = await agent.tool("calc", 3, async (x) => x * x);
    return v;
  });
  const toolEvents = r.events.filter((e) => /^agent:tool_/.test(e.type));
  result.A_tool_events = {
    finalResult: r.result,
    eventCount: r.events.length,
    eventTypesInOrder: r.events.map((e) => e.type),
    toolName: toolEvents[0]?.tool ?? null,
    seqs: r.events.map((e) => e.seq),
    monotonicAt: r.events.every((e, i) => i === 0 || e.at >= r.events[i - 1].at),
    sameAgentId: r.events.every((e) => e.agentId === r.events[0].agentId),
  };
  assert.equal(r.result, 9);
  assert.equal(toolEvents[0].type, "agent:tool_started");
  assert.equal(toolEvents[1].type, "agent:tool_succeeded");
  assert.equal(toolEvents[0].tool, "calc");
  assert.deepEqual(result.A_tool_events.seqs, [1, 2, 3, 4]);
  assert.ok(result.A_tool_events.monotonicAt);
  assert.ok(result.A_tool_events.sameAgentId);
}

// --- B -- AgentToolCalls budget hard cap ---------------------------------
{
  let outerError = null;
  let evidence = null;
  try {
    await run.context.with(AgentToolCalls, { spent: 0, limit: 1, unit: "tool_calls" }, async () => {
      await runAgent(async (agent) => {
        await agent.tool("first",  0, async () => "ok", { toolCalls: 1 });
        await agent.tool("second", 0, async () => "ok", { toolCalls: 1 }); // overflow
      });
    });
  } catch (err) {
    outerError = err;
    evidence = {
      class:      err?.constructor?.name,
      budgetKey:  err?.budgetKey,
      limit:      err?.limit,
      attempted:  err?.attempted,
    };
  }
  result.B_tool_calls_budget = evidence;
  assert.ok(outerError instanceof BudgetExceededError);
  assert.equal(outerError.budgetKey, "AgentToolCalls");
}

// --- C -- OpenAITokens budget consumed via tool opts ---------------------
{
  let final = null;
  await run.context.with(OpenAITokens, { spent: 0, limit: 1000, unit: "tokens" }, async () => {
    await runAgent(async (agent) => {
      await agent.tool("a", 1, async () => "ok", { tokens: 50 });
      await agent.tool("b", 2, async () => "ok", { tokens: 25 });
    });
    final = run.context.budget(OpenAITokens);
  });
  result.C_tokens_budget = { final };
  assert.equal(final.spent, 75);
}

// --- D -- parent cancel during tool propagates to tool body's signal -----
{
  let outerError = null;
  let toolSignalAborted = false;
  const winner = await Promise.race([
    (async () => {
      try {
        await runAgent(async (agent, ctx) => {
          const p = agent.tool("slow", 0, async (_, c) => {
            await new Promise((res, rej) => {
              if (c.signal.aborted) return rej(c.signal.reason);
              c.signal.addEventListener("abort", () => {
                toolSignalAborted = true;
                rej(c.signal.reason);
              }, { once: true });
            });
          });
          setTimeout(() => ctx.scope.cancel({ kind: "manual", tag: "user-stop" }), 10);
          await p;
        });
      } catch (err) { outerError = err; }
      return "done";
    })(),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 800)),
  ]);
  result.D_parent_cancel = {
    winner,
    toolSignalAborted,
    outerErrorClass: outerError?.constructor?.name ?? null,
    cancelReasonKind: outerError instanceof CancellationError ? outerError.reason.kind : null,
    cancelReasonTag:  outerError instanceof CancellationError && outerError.reason.kind === "manual"
      ? outerError.reason.tag : null,
  };
  assert.equal(winner, "done", "must not hit the 800ms watchdog");
  assert.equal(toolSignalAborted, true, "tool body's signal must observe the parent cancel");
  assert.ok(outerError instanceof CancellationError, "outer must reject with CancellationError");
  assert.equal(result.D_parent_cancel.cancelReasonKind, "manual");
}

// --- E -- replayable event log on a 3-tool run ---------------------------
{
  const r = await runAgent(async (agent) => {
    await agent.tool("plan",     "goal",   async () => ["fetch", "summarize"]);
    await agent.tool("fetch",    "https",  async () => "<doc>");
    await agent.tool("summarize","<doc>",  async () => "tl;dr");
    return "done";
  });
  result.E_replayable_log = {
    eventCount:        r.events.length,
    eventTypes:        r.events.map((e) => e.type),
    seqs:              r.events.map((e) => e.seq),
    monotonicAt:       r.events.every((e, i) => i === 0 || e.at >= r.events[i - 1].at),
    sameAgentId:       r.events.every((e) => e.agentId === r.events[0].agentId),
    toolStartedNames:  r.events.filter((e) => e.type === "agent:tool_started").map((e) => e.tool),
    toolSucceededNames:r.events.filter((e) => e.type === "agent:tool_succeeded").map((e) => e.tool),
  };
  assert.equal(r.result, "done");
  // 1 agent:started + 3 x (tool_started + tool_succeeded) + 1 agent:completed = 8
  assert.equal(r.events.length, 8);
  assert.deepEqual(result.E_replayable_log.toolStartedNames,   ["plan", "fetch", "summarize"]);
  assert.deepEqual(result.E_replayable_log.toolSucceededNames, ["plan", "fetch", "summarize"]);
  assert.ok(result.E_replayable_log.monotonicAt);
  assert.deepEqual(result.E_replayable_log.seqs, [1, 2, 3, 4, 5, 6, 7, 8]);
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
