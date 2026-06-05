/**
 * Real WorkIt-backed example runners for the use cases site.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CancellationError, ContextBagImpl, CostBudget, group, run } from "@workit/core";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export const runners = {
  "vibe-coding-agent": runAgentTree,
  "conversation-agent": runConversationAgent,
  "provider-fallback": runProviderFallback,
  "rag-pipeline": runRagPipeline,
};

async function runAgentTree() {
  const events = [];
  const cancelled = [];
  const cleanups = [];

  await run.scope(async (scope) => {
    const unsubscribe = scope.onEvent((event) => events.push(formatEvent(event)));
    const tools = ["search", "browser", "code"];
    const handles = tools.map((name) => scope.spawn(async (ctx) => {
      ctx.defer(() => cleanups.push(name));
      try {
        await sleep(1_000, ctx.signal);
        return name;
      } catch (error) {
        if (error instanceof CancellationError) {
          cancelled.push({ name, reason: error.reason });
        }
        throw error;
      }
    }, { name: `tool.${name}`, kind: "tool" }));

    await sleep(15, scope.signal);
    scope.cancel({ kind: "manual", tag: "user_stopped_agent" });
    await Promise.allSettled(handles);
    unsubscribe();
  }, { name: "agent.tree" });

  const reason = cancelled[0]?.reason ?? { kind: "manual", tag: "missing" };

  return {
    sample: "agent-tree-cancel",
    events,
    receipt: [
      "runtime: @workit/core",
      "sample: agent-tree-cancel",
      `cancelled: ${cancelled.map((item) => item.name).sort().join(", ")}`,
      `reason.kind: ${reason.kind}`,
      `reason.tag: ${reason.tag}`,
      `cleanups: ${cleanups.sort().join(", ")}`,
    ],
    code: await readSample("packages/core/samples/agent-tree-cancel.sample.js"),
  };
}

async function runProviderFallback() {
  const events = [];
  const cancelledProviders = [];

  const result = await run.scope(async (scope) => {
    const unsubscribe = scope.onEvent((event) => events.push(formatEvent(event)));
    const winner = await run.race([
      provider("openai", 50, cancelledProviders),
      provider("anthropic", 10, cancelledProviders),
      provider("gemini", 80, cancelledProviders),
    ]);
    unsubscribe();
    return winner;
  }, { name: "provider.race" });

  return {
    sample: "race-providers",
    events,
    receipt: [
      "runtime: @workit/core",
      "sample: race-providers",
      `winner: ${result.provider}`,
      `cancelledProviders: ${cancelledProviders.sort().join(", ")}`,
    ],
    code: await readSample("packages/core/samples/race-providers.sample.js"),
  };
}

async function runRagPipeline() {
  const events = [];
  const budget = { spent: 0, limit: 10, unit: "USD" };
  const context = new ContextBagImpl().with(CostBudget, budget);
  const audits = [];

  const answer = await run.scope(async (scope) => {
    const unsubscribe = scope.onEvent((event) => events.push(formatEvent(event)));
    const value = await group(async (task) => {
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

      return task(async (ctx) => {
        ctx.consumeCost(3);
        return `answer:${reranked[0]}`;
      }, { name: "rag.synthesize", kind: "llm" });
    }, { name: "rag.query", context });
    unsubscribe();
    return value;
  }, { name: "rag.runtime" });

  const finalBudget = context.get(CostBudget);

  return {
    sample: "budget-rag",
    events,
    receipt: [
      "runtime: @workit/core",
      "sample: budget-rag",
      `answer: ${answer}`,
      `spent: ${finalBudget.spent}`,
      `limit: ${finalBudget.limit}`,
      `audit.sources: ${audits[0]?.sources ?? 0}`,
    ],
    code: await readSample("packages/core/samples/budget-rag.sample.js"),
  };
}

async function runConversationAgent() {
  const events = [];
  const tokens = [];
  const cleanups = [];
  let memoryWrites = 0;

  const toolResults = await run.scope(async (scope) => {
    const unsubscribe = scope.onEvent((event) => events.push(formatEvent(event)));
    const stream = scope.spawn(async (ctx) => {
      ctx.defer(() => cleanups.push("stream"));
      for (const token of ["plan", "search", "edit", "reply"]) {
        await sleep(1, ctx.signal);
        tokens.push(token);
      }
      return tokens.length;
    }, { name: "llm.stream", kind: "llm" });

    const search = scope.spawn(async (ctx) => {
      ctx.defer(() => cleanups.push("tools"));
      await sleep(2, ctx.signal);
      return "search:2";
    }, { name: "tool.search", kind: "tool" });

    const repo = scope.spawn(async (ctx) => {
      await sleep(3, ctx.signal);
      return "repo:clean";
    }, { name: "tool.repo", kind: "tool" });

    const memory = scope.spawn(async (ctx) => {
      ctx.defer(() => cleanups.push("memory"));
      await sleep(4, ctx.signal);
      memoryWrites++;
      return memoryWrites;
    }, { name: "memory.write", kind: "io" });

    const results = await Promise.all([search, repo]);
    await Promise.all([stream, memory]);
    unsubscribe();
    return results;
  }, { name: "chat.turn" });

  return {
    sample: "conversation-agent",
    events,
    receipt: [
      "runtime: @workit/core",
      "sample: conversation-agent",
      `tokens: ${tokens.length}`,
      `toolResults: ${toolResults.join(", ")}`,
      `memoryWrites: ${memoryWrites}`,
      `cleanups: ${cleanups.sort().join(", ")}`,
    ],
    code: await readSample("packages/core/samples/conversation-agent.sample.js"),
  };
}

function provider(name, latencyMs, cancelledProviders) {
  return async (ctx) => {
    try {
      await sleep(latencyMs, ctx.signal);
      return { provider: name, text: `${name}:ok` };
    } catch (error) {
      if (error instanceof CancellationError) {
        cancelledProviders.push(name);
      }
      throw error;
    }
  };
}

function formatEvent(event) {
  switch (event.type) {
    case "task:started":
      return `${event.type} ${event.name}`;
    case "task:succeeded":
      return `${event.type} ${event.taskId}`;
    case "task:cancelled":
      return `${event.type} ${event.taskId} ${formatReason(event.reason)}`;
    case "scope:closing":
      return `${event.type} ${event.reason}`;
    case "scope:closed":
      return `${event.type} ${event.durationMs}ms`;
    default:
      return event.type;
  }
}

function formatReason(reason) {
  if (reason && typeof reason === "object" && "kind" in reason) {
    const tag = "tag" in reason ? `/${reason.tag}` : "";
    return `${reason.kind}${tag}`;
  }

  return "unknown";
}

function readSample(path) {
  return readFile(resolve(repoRoot, path), "utf8");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
