<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Agent Scopes And Tool Lifecycles

*Five articles built the runtime. The sixth made it observable. This one introduces the agent primitive: `runAgent` plus `AgentScope`, with budgets, replayable events, and structured cancellation in the box.*

The whole loop:

```ts
import { runAgent, AgentToolCalls, OpenAITokens } from "@workit/core/ai";
import { CostBudget, run } from "@workit/core";

const { result, events } = await runAgent(async (agent, ctx) => {
  const plan = await agent.tool("plan", goal, planLLM,
    { tokens: 600, cost: 0.001, retry: 2 });

  for (const step of plan.steps) {
    await agent.tool(step.tool, step.input, tools[step.tool],
      { tokens: 1_200, toolCalls: 1, timeout: "10s" });
  }

  return await agent.tool("synthesize", workspace, synthesizeLLM,
    { tokens: 2_000, cost: 0.004 });
});
```

That call returns two things -- `result` (whatever the body returned) and `events` (the **complete, ordered, type-discriminated trace** of the run). No external tracing setup. No DSL. The body is plain `async`/`await`, the tools are plain functions, and every `agent.tool(...)` call is a typed primitive whose budget, retry, and timeout policy live in the call site.

This is the practical lifecycle primitive between *"I wired up an LLM call and a tool router"* and *"I can explain, bound, cancel, and replay the run."*

---

## The contract -- `agent.tool(name, input, fn, opts)`

```ts
interface AgentScope {
  readonly id: string;
  readonly events: readonly AgentEvent[];
  tool<I, O>(
    name: string,
    input: I,
    fn:   (input: I, ctx: TaskContext) => O | Promise<O>,
    opts: AgentToolOptions,
  ): Promise<O>;
}

interface AgentToolOptions {
  tokens:    number;       // charged against OpenAITokens budget
  cost:      number;       // charged against CostBudget budget
  toolCalls: number;       // charged against AgentToolCalls budget
  retry:     number | RetryOpts;
  timeout:   Duration;
}
```

Five things to notice:

- **The tool function is a plain `(input, ctx) => Promise<O>`.** No generators. No effect type. No "tool description JSON schema" to feed an LLM -- that's your application's job, not the runtime's.
- **Budgets are charged before the call returns.** Overrun rejects synchronously and cancels the owning scope with `CancelReason { kind: "budget", budgetKey, limit, spent }`. Runtime budget accounting stops at the cap.
- **`retry`/`timeout` are per-tool**, composing with the same engine described in articles 02 and 05.
- **`ctx.signal` inside the tool body is linked to the parent scope.** Client disconnects, deadline fires, sibling fails -- all aborts propagate into the tool body so its `fetch` / `db.query` / `provider.call` aborts at the I/O boundary.
- **`agent.events` is a readonly buffer** that mirrors the event stream. After the run, `events` is a replayable log of the whole loop.

---

## A 50-cent agent with a hard tool-call cap

```ts
import { runAgent, AgentToolCalls, OpenAITokens } from "@workit/core/ai";
import { CostBudget, run } from "@workit/core";

await run.context.with(CostBudget,      { spent: 0, limit: 0.50,    unit: "USD" },
() => run.context.with(OpenAITokens,    { spent: 0, limit: 100_000, unit: "tokens" },
() => run.context.with(AgentToolCalls,  { spent: 0, limit: 20,      unit: "tool_calls" },
  () => runAgent(async (agent) => reactLoop(agent, goal)),
)));
```

Three caps, three reasons:

| Budget | What it bounds | What overrun does |
|---|---|---|
| `CostBudget`      | Aggregate USD across the whole run | Rejects with `BudgetExceededError` and cancels the owning scope. The 32 inflight LLM/tool calls see the abort on `ctx.signal`; provider-side billing depends on the provider honoring cancellation. |
| `OpenAITokens`    | Total tokens across all LLM calls  | Same shape. Use a dedicated key per provider when you want separate caps. |
| `AgentToolCalls`  | Total tool calls -- fan-out limiter | Stops a runaway agent from invoking tools forever. Bench 19-B caps it at 1 and the second tool call fails closed. |

> **Bench [`19-agent-scope.mjs`](../benchmarks/articles/19-agent-scope.mjs).** Five scenarios -- measured.
>
> | # | Scenario | Result |
> |---|---|---|
> | A | Tool events bracket execution | Single `agent.tool("calc", 3, x => x*x)` call -> 4 events `[agent:started, agent:tool_started, agent:tool_succeeded, agent:completed]`, sequential `seq: [1,2,3,4]`, monotonic `at`, stable `agentId`. |
> | B | `AgentToolCalls` cap hit | `limit: 1`. Second call rejects with `BudgetExceededError`, `budgetKey: "AgentToolCalls"`, `limit: 1`. |
> | C | `OpenAITokens` charged via opts | `{ tokens: 50 }` then `{ tokens: 25 }` -> final `spent: 75` exactly. |
> | D | Parent scope cancel during tool | `ctx.scope.cancel({ kind: "manual", tag: "user-stop" })` mid-tool -> tool body's `ctx.signal` aborts, outer settles `CancellationError` with `reason.kind: "manual"`, `tag: "user-stop"`. |
> | E | Replayable log, 3-tool run | 8 events: `started -> (tool_started -> tool_succeeded) x 3 -> completed`. Seq `[1..8]`. Same agentId. Tool names captured in order. |

---

## Replayable events -- the typed trace

```ts
type AgentEvent =
  | { type: "agent:started";        seq: number; agentId: string; at: number }
  | { type: "agent:tool_started";   seq: number; agentId: string; tool: string; at: number }
  | { type: "agent:tool_succeeded"; seq: number; agentId: string; tool: string; at: number }
  | { type: "agent:tool_failed";    seq: number; agentId: string; tool: string; error: string; at: number }
  | { type: "agent:tool_cancelled"; seq: number; agentId: string; tool: string; reason: CancelReason; at: number }
  | { type: "agent:completed";      seq: number; agentId: string; at: number }
  | { type: "agent:failed";         seq: number; agentId: string; error: string; at: number };
```

Seven variants. Discriminated by `type`. Every variant carries `seq` and `at`. Cancelled events carry the typed `CancelReason`.

What you can do with that:

- **Pivot a dashboard** on `tool` x `type` for failure heatmaps without parsing logs.
- **Replay a run** in a test by walking the events array -- you have the order, the names, the timing.
- **Audit a charge** by reconstructing the budget timeline from `tool_succeeded` events tagged with the tokens / cost charged at the call site.
- **Diff two runs** on the event sequence to see exactly which tool path diverged.

The events array on the `AgentRunResult` is `readonly` and mirrors the same event stream that flows through `scope.onEvent(...)` -- so live observers see the same shape the post-run audit log sees.

---

## How does this compare

| Stack | Tool primitive | Budget primitive | Replayable event log | Scope cancellation | Bundle |
|---|---|---|---|---|---|
| **WorkIt `runAgent`** | yes typed `(input, ctx) => O` | yes `CostBudget` / `OpenAITokens` / `AgentToolCalls` / `createBudget(...)` composable | yes `AgentRunResult.events` typed union | yes `ctx.signal` aborts each tool body | included in `@workit/core/ai` (~8 KB gzip with the rest of `/ai`) |
| LangChain agents | yes but typed loosely; many tools as JSON | no no first-class budget primitive | partial via callbacks | no no scope tree | ~hundreds of KB |
| Vercel AI SDK | yes tool schemas | no no first-class budget | events on stream | yes via `AbortSignal`, no scope tree | medium |
| Mastra | yes generators-based | partial | yes trace store | yes | medium |
| Roll-your-own with `for`-loop + `fetch` | yes, by definition | DIY | DIY | DIY | minimal but you wrote the runtime |

The design point: **the agent primitive composes with the same `CancelReason`, `ctx.signal`, `defer`, budget, and `scope.tree()` machinery from articles 01-06**. There is no second runtime. You don't choose between "the agent loop's lifecycle" and "the rest of your app's lifecycle" -- they share one tree.

---

## A complete, runnable example

```ts
import { runAgent, AgentToolCalls, OpenAITokens } from "@workit/core/ai";
import { CostBudget, run, renderTree } from "@workit/core";

const tools = {
  search: async ({ q }, ctx) =>
    fetch(`https://api.search.dev/q=${q}`, { signal: ctx.signal }).then(r => r.json()),

  fetchPage: async ({ url }, ctx) =>
    fetch(url, { signal: ctx.signal }).then(r => r.text()),

  summarize: async ({ text }, ctx) =>
    openai.chat({ messages: [{ role: "user", content: `tl;dr: ${text}` }] },
                { signal: ctx.signal }),
};

const { result, events } = await run.context.with(
  CostBudget, { spent: 0, limit: 0.50, unit: "USD" },
  () => run.context.with(
    AgentToolCalls, { spent: 0, limit: 12, unit: "tool_calls" },
    () => runAgent(async (agent) => {
      const hits = await agent.tool("search",
        { q: "structured concurrency typescript" }, tools.search,
        { toolCalls: 1, timeout: "5s", retry: 2 });

      const docs = await Promise.all(hits.slice(0, 3).map((hit, i) =>
        agent.tool(`fetchPage[${i}]`,
          { url: hit.url }, tools.fetchPage,
          { toolCalls: 1, timeout: "10s" })));

      return await agent.tool("summarize",
        { text: docs.join("\n\n") }, tools.summarize,
        { tokens: 4_000, cost: 0.02, toolCalls: 1, timeout: "30s" });
    }),
  ),
);

console.log(result);
console.log(events.map(e =>
  `${e.seq.toString().padStart(2)} ${e.type}${"tool" in e ? ` (${e.tool})` : ""}`,
).join("\n"));
```

That's an agent that searches, fetches three pages, summarises, and stops at 50 cents or 12 tool calls -- whichever comes first. Cancel the parent scope and every in-flight `fetch` and LLM stream aborts at the TCP layer. No manual `AbortController` plumbing. No "did I forget to thread the signal." No `try/catch` around the agent loop.

---

## Receipts

```sh
node benchmarks/articles/19-agent-scope.mjs           # 5 contract scenarios
node benchmarks/articles/run-all.mjs                  # full 19-bench suite
```

Production-side gates that back the same surface:

| Claim | Evidence |
|---|---|
| Tool events bracket execution with monotonic seq | [`19-agent-scope.mjs`](../benchmarks/articles/19-agent-scope.mjs) A verifies four ordered events, sequential `seq`, stable `agentId`, and monotonic `at`. |
| `AgentToolCalls` overflow rejects with `BudgetExceededError` | Bench 19 B sets `limit: 1`; the second tool call throws with `budgetKey: "AgentToolCalls"`. |
| `OpenAITokens` consumed via `{ tokens: N }` | Bench 19 C verifies the final token budget `spent` is exactly `75`. |
| Parent scope cancel propagates into tool body | Bench 19 D verifies the tool body observes abort and the outer scope settles with the original manual reason. |
| Replayable, ordered, typed event log | Bench 19 E verifies eight events, sequential `seq`, monotonic `at`, and tool names in call order. |
| Tool failure surfaces as `agent:tool_failed` | Unit coverage verifies tool errors propagate and are captured in the typed event log. |

---

## Closing The Series

The important part is not that WorkIt has an agent helper. The important part is
that the agent helper is not a second runtime. Tool calls, token budgets,
timeouts, retries, cancellation, progress events, and cleanup all use the same
ownership tree as the rest of the library.

The public claims behind this series are tracked in
[`evidence/claims.json`](../evidence/claims.json), exercised by
`npm run test:evidence`, and benchmarked by `npm run bench:articles`. The prose
is intentionally not the evidence store; it is the readable path through the
engineering tradeoffs.

---

## Source, Benchmarks, And Evidence

- Source: https://github.com/WorkRuntime/workit
- Article source: https://github.com/WorkRuntime/workit/blob/main/articles/07-agent-scope-and-tool-lifecycles.md
- Reproduce: `npm run bench:articles` and `npm run test:evidence`
