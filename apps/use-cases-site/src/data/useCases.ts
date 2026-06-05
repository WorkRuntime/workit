/**
 * Real WorkIt examples mapped to runtime features and evidence paths.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UseCase } from "../types";
import evidenceSnapshots from "./generated/evidence-snapshots.json";

interface SampleSnapshot<T> {
  path: string;
  result: T;
  source: string;
}

interface AgentTreeCancelResult {
  sample: "agent-tree-cancel";
  cancelled: string[];
  reason: {
    kind: string;
    tag: string;
  };
  cleanups: string[];
}

interface ConversationAgentResult {
  sample: "conversation-agent";
  tokens: string[];
  toolResults: string[];
  memoryWrites: number;
  cleanups: string[];
}

interface RaceProvidersResult {
  sample: "race-providers";
  winner: string;
  cancelledProviders: string[];
}

interface BudgetRagResult {
  sample: "budget-rag";
  answer: string;
  spent: number;
  limit: number;
  audits: Array<{ rewritten: string; sources: number }>;
}

const samples = evidenceSnapshots.samples as Record<string, SampleSnapshot<unknown>>;

function sample<T>(id: string): SampleSnapshot<T> {
  const snapshot = samples[id];

  if (!snapshot) {
    throw new Error(`Missing generated evidence snapshot for ${id}.`);
  }

  return snapshot as SampleSnapshot<T>;
}

const agentEvidence = sample<AgentTreeCancelResult>("agent-tree-cancel");
const conversationEvidence = sample<ConversationAgentResult>("conversation-agent");
const raceEvidence = sample<RaceProvidersResult>("race-providers");
const ragEvidence = sample<BudgetRagResult>("budget-rag");

function list(values: string[]) {
  return values.join(", ");
}

function sampleEvents(snapshot: SampleSnapshot<{ sample: string }>, fields: string[]) {
  return [`sample: ${snapshot.result.sample}`, `source: ${snapshot.path}`, ...fields];
}

export const useCases: UseCase[] = [
  {
    id: "vibe-coding-agent",
    title: "Vibe coding agent",
    audience: "AI coding tools",
    summary: "A user changes direction while the agent is editing, testing, and analyzing the repo.",
    pain: "A coding turn is a tree of searches, edits, shell commands, LLM calls, and cleanup. Without one owner, old work can keep running after the user redirects.",
    answer: "Run each turn inside one WorkIt scope. Child tasks inherit cancellation, cleanup, context, and diagnostics from the turn owner.",
    primarySample: agentEvidence.path,
    features: [
      { label: "scope ownership", reason: "One turn owns every child task.", tone: "emerald" },
      { label: "propagated cancellation", reason: "One manual scope cancel reaches search, browser, and code tools.", tone: "coral" },
      { label: "cleanup handlers", reason: "Each tool registers a defer cleanup that runs after cancellation.", tone: "amber" },
      { label: "receipt fields", reason: "Generated snapshot records cancelled tools, reason, and cleanup list.", tone: "cobalt" },
    ],
    flow: [
      { userAction: "Sample starts one parent scope", runtimeOwner: "agent.tree", feature: "scope per turn" },
      { userAction: "Sample spawns tool tasks", runtimeOwner: "tool.search/tool.browser/tool.code", feature: "child task ownership" },
      { userAction: "Parent scope cancels", runtimeOwner: "agent.tree", feature: "typed cancellation reason" },
      { userAction: "Each tool records cancellation", runtimeOwner: "CancellationError", feature: "shared reason propagation" },
      { userAction: "Each defer records cleanup", runtimeOwner: "ctx.defer", feature: "cleanup ownership" },
    ],
    runtimeTree: [
      {
        id: "turn",
        label: "agent.tree",
        kind: "scope",
        statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
        children: [
          {
            id: "search",
            label: "tool.search",
            kind: "tool",
            statusByPhase: { idle: "waiting", running: "running", completed: "cancelled", aborted: "cancelled" },
          },
          {
            id: "browser",
            label: "tool.browser",
            kind: "tool",
            statusByPhase: { idle: "waiting", running: "running", completed: "cancelled", aborted: "cancelled" },
          },
          {
            id: "code",
            label: "tool.code",
            kind: "tool",
            statusByPhase: { idle: "waiting", running: "running", completed: "cancelled", aborted: "cancelled" },
          },
          {
            id: "cleanup",
            label: "ctx.defer cleanups",
            kind: "defer",
            statusByPhase: { idle: "waiting", running: "waiting", completed: "done", aborted: "done" },
          },
        ],
      },
    ],
    events: {
      idle: sampleEvents(agentEvidence, ["status: ready"]),
      running: sampleEvents(agentEvidence, [
        `cancelled: ${list(agentEvidence.result.cancelled)}`,
        `reason: ${agentEvidence.result.reason.kind}/${agentEvidence.result.reason.tag}`,
        `cleanups: ${list(agentEvidence.result.cleanups)}`,
      ]),
      completed: sampleEvents(agentEvidence, [
        `cancelled: ${list(agentEvidence.result.cancelled)}`,
        `reason: ${agentEvidence.result.reason.kind}/${agentEvidence.result.reason.tag}`,
        `cleanups: ${list(agentEvidence.result.cleanups)}`,
      ]),
      aborted: sampleEvents(agentEvidence, [
        `cancelled: ${list(agentEvidence.result.cancelled)}`,
        `reason: ${agentEvidence.result.reason.kind}/${agentEvidence.result.reason.tag}`,
        `cleanups: ${list(agentEvidence.result.cleanups)}`,
      ]),
    },
    receipt: {
      idle: [`sample: ${agentEvidence.result.sample}`, `source: ${agentEvidence.path}`],
      running: [
        `cancelled.count: ${agentEvidence.result.cancelled.length}`,
        `reason.kind: ${agentEvidence.result.reason.kind}`,
        `reason.tag: ${agentEvidence.result.reason.tag}`,
        `cleanups.count: ${agentEvidence.result.cleanups.length}`,
      ],
      completed: [
        `cancelled.count: ${agentEvidence.result.cancelled.length}`,
        `reason.kind: ${agentEvidence.result.reason.kind}`,
        `reason.tag: ${agentEvidence.result.reason.tag}`,
        `cleanups.count: ${agentEvidence.result.cleanups.length}`,
      ],
      aborted: [
        `cancelled.count: ${agentEvidence.result.cancelled.length}`,
        `reason.kind: ${agentEvidence.result.reason.kind}`,
        `reason.tag: ${agentEvidence.result.reason.tag}`,
        `cleanups.count: ${agentEvidence.result.cleanups.length}`,
      ],
    },
    evidence: [
      {
        claim: "Parent cancellation reaches in-flight tool work.",
        path: "packages/core/samples/agent-tree-cancel.sample.js",
        invariant: "search, browser, and code tasks all cancel with the same reason.",
        status: "tracked",
      },
      {
        claim: "Cleanup runs after cancellation.",
        path: "packages/core/tests/unit/sanity.test.js",
        invariant: "deferred cleanup executes for cancelled scope work.",
        status: "tracked",
      },
    ],
    code: agentEvidence.source,
  },
  {
    id: "conversation-agent",
    title: "Conversation agent",
    audience: "LLM chat runtimes",
    summary: "A chat turn streams tokens, calls tools, stores memory, and must stop when the next turn supersedes it.",
    pain: "Most chat code treats a turn like one promise, but real turns contain streaming, tool fanout, memory writes, and cleanup.",
    answer: "Give every turn an owned scope and emit typed lifecycle events for stream, tool, memory, and cleanup boundaries.",
    primarySample: conversationEvidence.path,
    features: [
      { label: "owned child tasks", reason: "Tools, memory, and stream work belong to the same turn.", tone: "emerald" },
      { label: "typed events", reason: "Every lifecycle boundary can be rendered or exported.", tone: "cobalt" },
      { label: "cleanup", reason: "Stream handles close when a turn is superseded.", tone: "amber" },
      { label: "timeouts", reason: "Slow tools cannot hold the whole conversation open.", tone: "coral" },
    ],
    flow: [
      { userAction: "User sends a chat turn", runtimeOwner: "chat.turn", feature: "scope ownership" },
      { userAction: "Assistant streams response", runtimeOwner: "llm.stream", feature: "child task lifecycle" },
      { userAction: "Tools run in parallel", runtimeOwner: "tool.search/tool.repo", feature: "bounded fanout" },
      { userAction: "New turn supersedes old turn", runtimeOwner: "chat.turn", feature: "propagated cancellation" },
      { userAction: "State writer closes", runtimeOwner: "memory.write", feature: "cleanup receipt" },
    ],
    runtimeTree: [
      {
        id: "chat",
        label: "chat.turn",
        kind: "scope",
        statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
        children: [
          {
            id: "stream",
            label: "llm.stream",
            kind: "llm",
            statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
          },
          {
            id: "search",
            label: "tool.search",
            kind: "tool",
            statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
          },
          {
            id: "repo",
            label: "tool.repo",
            kind: "tool",
            statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
          },
          {
            id: "memory",
            label: "memory.write",
            kind: "store",
            statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "done" },
          },
        ],
      },
    ],
    events: {
      idle: sampleEvents(conversationEvidence, ["status: ready"]),
      running: sampleEvents(conversationEvidence, [
        `tokens: ${conversationEvidence.result.tokens.length}`,
        `toolResults: ${list(conversationEvidence.result.toolResults)}`,
        `memoryWrites: ${conversationEvidence.result.memoryWrites}`,
        `cleanups: ${list(conversationEvidence.result.cleanups)}`,
      ]),
      completed: sampleEvents(conversationEvidence, [
        `tokens: ${conversationEvidence.result.tokens.length}`,
        `toolResults: ${list(conversationEvidence.result.toolResults)}`,
        `memoryWrites: ${conversationEvidence.result.memoryWrites}`,
        `cleanups: ${list(conversationEvidence.result.cleanups)}`,
      ]),
      aborted: sampleEvents(conversationEvidence, [
        `tokens: ${conversationEvidence.result.tokens.length}`,
        `toolResults: ${list(conversationEvidence.result.toolResults)}`,
        `memoryWrites: ${conversationEvidence.result.memoryWrites}`,
        `cleanups: ${list(conversationEvidence.result.cleanups)}`,
      ]),
    },
    receipt: {
      idle: [`sample: ${conversationEvidence.result.sample}`, `source: ${conversationEvidence.path}`],
      running: [
        `tokens: ${conversationEvidence.result.tokens.length}`,
        `toolResults: ${list(conversationEvidence.result.toolResults)}`,
        `memoryWrites: ${conversationEvidence.result.memoryWrites}`,
        `cleanups.count: ${conversationEvidence.result.cleanups.length}`,
      ],
      completed: [
        `tokens: ${conversationEvidence.result.tokens.length}`,
        `toolResults: ${list(conversationEvidence.result.toolResults)}`,
        `memoryWrites: ${conversationEvidence.result.memoryWrites}`,
        `cleanups.count: ${conversationEvidence.result.cleanups.length}`,
      ],
      aborted: [
        `tokens: ${conversationEvidence.result.tokens.length}`,
        `toolResults: ${list(conversationEvidence.result.toolResults)}`,
        `memoryWrites: ${conversationEvidence.result.memoryWrites}`,
        `cleanups.count: ${conversationEvidence.result.cleanups.length}`,
      ],
    },
    evidence: [
      {
        claim: "Streaming work can be scoped with the same owner as tool work.",
        path: "packages/core/samples/conversation-agent.sample.js",
        invariant: "stream, tool, memory, and cleanup work stay under one runtime owner.",
        status: "tracked",
      },
      {
        claim: "Agent trees expose cancellable child lifecycles.",
        path: "packages/core/samples/agent-tree-cancel.sample.js",
        invariant: "in-flight child tasks receive the parent cancellation reason.",
        status: "tracked",
      },
    ],
    code: conversationEvidence.source,
  },
  {
    id: "provider-fallback",
    title: "LLM provider fallback",
    audience: "AI platform teams",
    summary: "Race providers for latency while making sure losing requests do not keep burning tokens.",
    pain: "Promise.race returns the first result, but the slower provider calls may still run unless every adapter cooperates manually.",
    answer: "Use a WorkIt race where every provider receives the runtime signal and the losing branches are cancelled.",
    primarySample: raceEvidence.path,
    features: [
      { label: "run.race", reason: "First successful provider wins.", tone: "emerald" },
      { label: "loser cancellation", reason: "Slow requests stop through the same signal.", tone: "coral" },
      { label: "provider receipts", reason: "Winner and cancelled providers are explicit.", tone: "cobalt" },
      { label: "timeouts", reason: "A bad provider cannot hold the route open.", tone: "amber" },
    ],
    flow: [
      { userAction: "Request needs an LLM response", runtimeOwner: "provider.race", feature: "run.race" },
      { userAction: "Three providers start", runtimeOwner: "openai/anthropic/gemini", feature: "shared signal" },
      { userAction: "Fast provider wins", runtimeOwner: "anthropic.call", feature: "first result" },
      { userAction: "Slow providers stop", runtimeOwner: "openai/gemini", feature: "loser cancellation" },
    ],
    runtimeTree: [
      {
        id: "race",
        label: "provider.race",
        kind: "race",
        statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
        children: [
          {
            id: "openai",
            label: "openai.call",
            kind: "llm",
            statusByPhase: { idle: "waiting", running: "running", completed: "cancelled", aborted: "cancelled" },
          },
          {
            id: "anthropic",
            label: "anthropic.call",
            kind: "llm",
            statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
          },
          {
            id: "gemini",
            label: "gemini.call",
            kind: "llm",
            statusByPhase: { idle: "waiting", running: "running", completed: "cancelled", aborted: "cancelled" },
          },
        ],
      },
    ],
    events: {
      idle: sampleEvents(raceEvidence, ["status: ready"]),
      running: sampleEvents(raceEvidence, [
        `winner: ${raceEvidence.result.winner}`,
        `cancelledProviders: ${list(raceEvidence.result.cancelledProviders)}`,
      ]),
      completed: sampleEvents(raceEvidence, [
        `winner: ${raceEvidence.result.winner}`,
        `cancelledProviders: ${list(raceEvidence.result.cancelledProviders)}`,
      ]),
      aborted: sampleEvents(raceEvidence, [
        `winner: ${raceEvidence.result.winner}`,
        `cancelledProviders: ${list(raceEvidence.result.cancelledProviders)}`,
      ]),
    },
    receipt: {
      idle: [`sample: ${raceEvidence.result.sample}`, `source: ${raceEvidence.path}`],
      running: [
        `winner: ${raceEvidence.result.winner}`,
        `cancelledProviders.count: ${raceEvidence.result.cancelledProviders.length}`,
        `cancelledProviders: ${list(raceEvidence.result.cancelledProviders)}`,
      ],
      completed: [
        `winner: ${raceEvidence.result.winner}`,
        `cancelledProviders.count: ${raceEvidence.result.cancelledProviders.length}`,
        `cancelledProviders: ${list(raceEvidence.result.cancelledProviders)}`,
      ],
      aborted: [
        `winner: ${raceEvidence.result.winner}`,
        `cancelledProviders.count: ${raceEvidence.result.cancelledProviders.length}`,
        `cancelledProviders: ${list(raceEvidence.result.cancelledProviders)}`,
      ],
    },
    evidence: [
      {
        claim: "Provider race cancels losing requests.",
        path: "packages/core/samples/race-providers.sample.js",
        invariant: "anthropic wins and openai/gemini are cancelled.",
        status: "tracked",
      },
    ],
    code: raceEvidence.source,
  },
  {
    id: "rag-pipeline",
    title: "RAG answer pipeline",
    audience: "Knowledge systems",
    summary: "Rewrite, embed, retrieve, rerank, synthesize, and audit under one bounded request owner.",
    pain: "RAG often combines unrelated async work with different costs, latencies, and cleanup obligations.",
    answer: "WorkIt composes parallel work, racing, hedging, background audit work, and a cost budget under the same scope.",
    primarySample: ragEvidence.path,
    features: [
      { label: "context budget", reason: "Cost follows the request owner.", tone: "amber" },
      { label: "run.all", reason: "Rewrite and embedding compose safely.", tone: "emerald" },
      { label: "run.hedge", reason: "Slow reranking can be hedged without losing ownership.", tone: "cobalt" },
      { label: "background work", reason: "Audit work remains attached to the parent lifecycle.", tone: "ink" },
    ],
    flow: [
      { userAction: "Question arrives", runtimeOwner: "rag.query", feature: "named scope" },
      { userAction: "Rewrite and embed", runtimeOwner: "rag.prepare", feature: "run.all" },
      { userAction: "Race retrieval paths", runtimeOwner: "rag.sources", feature: "run.race" },
      { userAction: "Hedge reranking", runtimeOwner: "rag.rerank", feature: "run.hedge" },
      { userAction: "Synthesize and audit", runtimeOwner: "rag.synthesize", feature: "budget + background" },
    ],
    runtimeTree: [
      {
        id: "rag",
        label: "rag.query",
        kind: "scope",
        statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
        children: [
          {
            id: "prepare",
            label: "rag.prepare",
            kind: "group",
            statusByPhase: { idle: "waiting", running: "done", completed: "done", aborted: "done" },
          },
          {
            id: "sources",
            label: "rag.sources",
            kind: "race",
            statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
          },
          {
            id: "rerank",
            label: "rag.rerank",
            kind: "llm",
            statusByPhase: { idle: "waiting", running: "running", completed: "done", aborted: "cancelled" },
          },
          {
            id: "audit",
            label: "rag.audit",
            kind: "background",
            statusByPhase: { idle: "waiting", running: "waiting", completed: "done", aborted: "done" },
          },
        ],
      },
    ],
    events: {
      idle: sampleEvents(ragEvidence, ["status: ready"]),
      running: sampleEvents(ragEvidence, [
        `answer: ${ragEvidence.result.answer}`,
        `spent: ${ragEvidence.result.spent}`,
        `limit: ${ragEvidence.result.limit}`,
        `audits: ${ragEvidence.result.audits.length}`,
      ]),
      completed: sampleEvents(ragEvidence, [
        `answer: ${ragEvidence.result.answer}`,
        `spent: ${ragEvidence.result.spent}`,
        `limit: ${ragEvidence.result.limit}`,
        `audits: ${ragEvidence.result.audits.length}`,
      ]),
      aborted: sampleEvents(ragEvidence, [
        `answer: ${ragEvidence.result.answer}`,
        `spent: ${ragEvidence.result.spent}`,
        `limit: ${ragEvidence.result.limit}`,
        `audits: ${ragEvidence.result.audits.length}`,
      ]),
    },
    receipt: {
      idle: [`sample: ${ragEvidence.result.sample}`, `source: ${ragEvidence.path}`],
      running: [
        `answer: ${ragEvidence.result.answer}`,
        `spent: ${ragEvidence.result.spent}`,
        `limit: ${ragEvidence.result.limit}`,
        `audit.sources: ${ragEvidence.result.audits[0]?.sources ?? 0}`,
      ],
      completed: [
        `answer: ${ragEvidence.result.answer}`,
        `spent: ${ragEvidence.result.spent}`,
        `limit: ${ragEvidence.result.limit}`,
        `audit.sources: ${ragEvidence.result.audits[0]?.sources ?? 0}`,
      ],
      aborted: [
        `answer: ${ragEvidence.result.answer}`,
        `spent: ${ragEvidence.result.spent}`,
        `limit: ${ragEvidence.result.limit}`,
        `audit.sources: ${ragEvidence.result.audits[0]?.sources ?? 0}`,
      ],
    },
    evidence: [
      {
        claim: "RAG budget and background audit work remain attached to the request owner.",
        path: "packages/core/samples/budget-rag.sample.js",
        invariant: "answer is produced, budget spent is 8, audit record is written.",
        status: "tracked",
      },
    ],
    code: ragEvidence.source,
  },
];

export const defaultUseCase = useCases[0];
