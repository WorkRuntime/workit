<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Observability Without Core Bloat

*Last time we put hard budgets on cost and guaranteed cleanup. This time we make sure you can inspect an agent run without making telemetry volume the default cost center.*

Take a real number. An agent does 200 tool calls per run. Each tool emits 5 events. That's 1,000 events per run. 100K runs/day = **100 million events/day**.

At CloudWatch Logs ingestion ($0.50/GB) with 500-byte structured JSON, that is roughly **$9,125/year of telemetry that may not be needed on successful runs.** Datadog APM, Application Insights, and Honeycomb have different pricing models, but the engineering issue is the same: unbounded event volume turns observability into a cost surface.

WorkIt's core has zero networking imports.

```sh
$ grep -E "node:http|node:https|fetch" dist/index.js
$
```

That's not a feature claim. That's a gate.

> **Bench [`15-core-zero-network.mjs`](../benchmarks/articles/15-core-zero-network.mjs).** Walks the published `dist/` tree (excluding the explicit `observability`, `otel`, and `worker` subpaths), greps every `.js`/`.cjs`/`.mjs` for `node:http`, `node:https`, raw `http`/`https` imports, and `fetch(...)`.
>
> | Metric | Result |
> |---|---|
> | Files scanned | 14 |
> | Forbidden imports found | **0** |
> | Excluded subpaths | `observability`, `otel`, `worker` |
> | `assert.equal(hits.length, 0)` | passed |

If a PR adds a networking import to core, the production gate `npm run check:no-network` fails. The bench above verifies the same property in the artifact a consumer installs from npm.

---

## Layer 1 -- Local-first by default (cost: $0)

```ts
import { run, renderTree } from "@workit/core";

const result = await run.scope(async (scope) => {
  // your agent code
  console.log(renderTree(scope.status()));
  return await doWork(scope);
});
```

Zero network calls. Zero log lines. Zero telemetry export cost. `scope.status()` returns a snapshot. `renderTree(...)` prints an ASCII tree. That is the built-in observability surface; exporters are opt-in.

When you do want telemetry, you opt in:

```ts
import { attachTelemetryExporter } from "@workit/core/observability";

const attachment = attachTelemetryExporter(scope, async (event) => {
  await otlp.write(event);
}, {
  sampling:       { mode: "errors_and_slow", slowThresholdMs: 2_000 },
  circuitBreaker: { failureThreshold: 3, openForMs: 60_000 },
  sanitize:       (event) => stripPII(event),
});
```

Four words: **sampled, aggregated, budgeted, circuit-broken.**

---

## Layer 2 -- Sampling: errors_and_slow is the production default

Same workload, same agent. With `errors_and_slow` (slow threshold 2 seconds) and 95% of runs completing fast and successful:

| Workload | Without sampling | With `errors_and_slow` (2 s) | Reduction |
|---|---|---|---|
| 100K runs/day, 5% slow/errored | 100K x 1,000 ev x 500 B = **50 GB/day** | 5K x 1,000 ev x 500 B = **2.5 GB/day** | **20x** |
| CloudWatch Logs ingestion | $25/day = **$9,125/year** | $1.25/day = **$456/year** | **$8,669/yr saved** |

The intended debugging signal is preserved for slow and failing runs. A passing run rarely needs full trace inspection -- you need it when something breaks or hangs, which is exactly what this policy keeps.

> **Bench [`16-sampling-and-aggregation.mjs`](../benchmarks/articles/16-sampling-and-aggregation.mjs).** 100 root scopes x 5 child tasks each. 5% slow, 2% errored. Both modes attach `attachTelemetryExporter` to the same workload.
>
> | `sampling.mode` | Exported events | Reduction factor |
> |---|---|---|
> | `"all"` | **1,300** | baseline |
> | `"errors_and_slow"` (slowThresholdMs: 55) | **36** | **~36x** |
>
> The bench asserts >= 5x to stay tolerant of jitter. The measured ratio came out higher than the article's nominal 20x because the synthetic workload concentrates slow/errored scopes; the savings table above uses the conservative ratio.

**Sampling modes -- how to choose:**

| Mode | Use case |
|---|---|
| `"off"` | Local dev, high-volume tests -- same shape as Layer 1 ($0) |
| `"errors_and_slow"` | **Production default** -- keep failing and slow traces, drop the rest |
| `"head"` | Random sampling at scope start -- cheap, no buffering, good for high-throughput service tracing |
| `"all"` | Debugging session for one run -- opt-in firehose |

A child scope cannot upgrade itself to "kept" if its root was sampled out. This is the rule that keeps traces causally intact.

---

## Layer 3 -- Aggregation, not enumeration

By default, an aggregated exporter receives **one summary record per scope**, not per task:

```ts
interface ScopeSummary {
  scopeId: string;
  parentId: string | null;
  durationMs: number;
  outcome: "completed" | "errored" | "cancelled";
  taskCounts: {
    started: number; succeeded: number; failed: number;
    cancelled: number; retried: number; cleanupFailed: number;
  };
  droppedTelemetryEvents: number;
}
```

200 tasks succeed -> **1 summary record exported**. Not 200. Not 1,000.

```ts
import { attachScopeSummaryExporter } from "@workit/core/observability";

attachScopeSummaryExporter(scope, async (summary) => {
  await otlp.writeAggregate(summary);
}, { /* same circuit breaker / queue / sampling options */ });
```

| Aggregation level | Records per scope | When to use |
|---|---|---|
| Scope summary (default) | 1 per closed scope | Production -- cost-efficient |
| Hybrid (summary + per-task for failures/slow) | summary + N | Investigating a specific failure pattern |
| Per-task firehose | one per event | Short opt-in debug session |

The summary aggregator is exercised end-to-end by `npm run check:exporter-stress` -- 100,000 events with bounded queue and drop-front under back-pressure. The bench in this folder skips the summary path on purpose: `attachScopeSummaryExporter` needs the `scope:opened` event, which fires before user code can attach inside `run.scope`. Companion packages wire it earlier; the production gate covers it.

---

## Layer 4 -- Telemetry budget (the safety net)

```ts
import { TelemetryBudget, run } from "@workit/core";

await run.context.with(
  TelemetryBudget,
  { spent: 0, limit: 100_000, unit: "events" },
  () => agentRun(),
);
```

The exporter checks the budget before emitting each event. When a scope's event count would exceed the limit, the event is **dropped silently**. The first overrun emits one warning. Subsequent overruns are counted into the next scope summary's `droppedTelemetryEvents` field. Tasks **continue executing normally**.

**Telemetry overrun must never affect application behaviour.** The companion `withOTel` wrap sets a default budget at the wrap-call boundary, so the floor is opt-out, not opt-in.

---

## Cardinality Discipline And Cost Control

Every exported field is classified bounded or unbounded. Unbounded fields are **never** emitted as metric labels.

| Field | Bound | In metric labels |
|---|---|---|
| `scope.name` | dev-chosen | yes |
| `task.kind` | 5 fixed values (`io`/`llm`/`tool`/`cpu`/`custom`) | yes |
| `outcome` | 3 values | yes |
| `cancelReason.kind` | 9 values | yes |
| `error.name` | finite by class | yes |
| `attempt` | bounded by retry limit | yes (bucketed) |
| `task.id` | unbounded UUID | **no** |
| `error.message` | unbounded text | **no** |
| `meta.*` | user-controlled | explicit opt-in only |

Wrap your metric exporter with `createCardinalitySafeMetricExporter` and pass an `allowedLabels` allow-list -- anything outside is rejected at runtime.

> **Bench [`17-cardinality-safe-metrics.mjs`](../benchmarks/articles/17-cardinality-safe-metrics.mjs).** Five candidate metric points, allow-list `["task.kind", "outcome", "scope.name"]`.
>
> | Point | Labels | Outcome |
> |---|---|---|
> | 1 | `{ "task.kind": "io",  "outcome": "succeeded" }` | yes emitted |
> | 2 | `{ "task.kind": "llm", "outcome": "failed" }`    | yes emitted |
> | 3 | `{ "task.kind": "tool", "task.id": "uuid-abc" }` | no rejected -- `Metric label "task.id" is not in the allowed label set` |
> | 4 | `{ "task.kind": "io",  "error.message": "EHOSTUNREACH at 10.0.0.42 retrying" }` | no rejected -- `Metric label "error.message" is not in the allowed label set` |
> | 5 | `{ "task.kind": "evil" }` | yes emitted (label-key check only -- out-of-enum *value* validation is the OTel-adapter's job) |

The wrapper rejects unbounded label **keys** at runtime. Out-of-enum value rejection (`taskKind: "evil"` failing in OTel) is enforced by the adapter contract, while the wrapper keeps cardinality control at the label-key boundary.

**Correct usage:**

```ts
task(() => fetch(url),       { kind: "io" });     // yes
task(() => llm.call(prompt), { kind: "llm" });    // yes
task(() => runTool(input),   { kind: "tool" });   // yes
task(() => heavyCalc(),      { kind: "cpu" });    // yes
task(() => custom(),         { kind: "custom" }); // yes
```

---

## Exporter circuit breaker -- the OOM defence

```ts
{
  circuitBreaker: { failureThreshold: 10, openForMs: 5 * 60_000 },
  queue:          { maxItems: 10_000, maxBytes: 10 * 1024 * 1024 },
}
```

OTLP backend goes down. The exporter sees N consecutive failures -> opens for `openForMs` -> events drop (counted, not queued). The bounded queue uses **drop-front** when full, so you keep the most recent context. After `openForMs` elapses -> half-open -> trial export -> close on success.

Result: **process memory growth bounded under 50 MB** through 1,000 scopes against a backend that returns 503 for every request. Tracked under `tests/perf/exporter-failure.test.ts`. This is the feature that prevents the most embarrassing observability incident -- the telemetry agent eating all process memory because the backend is unreachable. Datadog had this. New Relic had this. We design it out.

---

## `scope.tree()` -- the print statement for agents

```
agent-run
|- ok planLLM (243ms)
|- retry fetchTool (attempt 2/3)
|  `- [running] retry-delay (120ms)
|- [running] summarize (running, 45% -- "embedding chunks")
`- failed auditLog (TimeoutError)

5 tasks * 1 ok * 1 failed * 2 running * 1 retrying * deadline in 12s
```

Print this when something breaks. Print this in your test runner. Print this from a SIGUSR1 dump.

| Icon | Meaning |
|---|---|
| `ok` | succeeded (durationMs) |
| `failed` | failed (error.name) |
| `cancelled` | cancelled (reason.kind) |
| `[running]` | running (elapsed -- message) |
| `retry` | retrying (attempt N/total) |
| `pending` | pending |

```ts
import { renderTree } from "@workit/core";
console.log(renderTree(scope.status()));
```

### Progress is a typed event, not a log line

Inside any task body, `ctx.report({ pct, message, data })` emits a typed `task:progress` event tagged with the task's stable id and name. Your exporter, your dashboard, your test assertion all pivot on the same shape. No `console.log`. No string parsing. No grep.

```ts
// samples/progress-parallel.sample.js
const TARGET = "embed.batch.7";

await run.scope(async (scope) => {
  scope.onEvent((event) => {
    if (event.type === "task:progress" && taskNames.get(event.taskId) === TARGET) {
      targetProgress.push({ pct: event.pct, message: event.message });
    }
  });

  const handles = Array.from({ length: 16 }, (_, i) => scope.spawn(async (ctx) => {
    if (i === 7) {
      for (const step of [1, 2, 3, 4]) {
        ctx.report({ pct: step / 4, message: `chunk-${step}` });
        await sleep(1, ctx.signal);
      }
    } else { await sleep(8, ctx.signal); }
  }, { name: `embed.batch.${i}`, kind: "llm" }));

  return await Promise.all(handles);
});

// Asserted by the sample:
//   targetProgress.map(e => e.pct) === [0.25, 0.5, 0.75, 1]
//   maxActive === 16
```

16 parallel embeddings. One of them is `embed.batch.7`. We filter the event stream to that task's id and watch the progress sequence land -- `[0.25, 0.5, 0.75, 1]`, with the messages `chunk-1`..`chunk-4` attached. The other 15 siblings run concurrently and don't interleave their reports into our channel because every event carries the typed `taskId`.

```sh
npm run sample:progress
```

That's the difference between "tail the log file and hope" and "subscribe to a typed event stream and pivot on the shape that the type system already validated."

### Snapshots: the stable view of a live runtime

The hot runtime exposes **stable snapshots**, not live references. Pull one whenever you need to inspect -- the engine doesn't mutate it, you can hand it to anything (logger, diagnostics, test assertion, JSON wire).

```ts
import type { ScopeSnapshot, TaskSnapshot } from "@workit/core";

const snapshot: ScopeSnapshot = scope.status();

interface ScopeSnapshot {
  id: ScopeId;
  name: string;
  status: "running" | "cancelling" | "closed";
  startedAt: number;
  deadlineAt: number;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  tasks:  TaskSnapshot[];     // every task currently owned by this scope
  scopes: ScopeSnapshot[];    // every child scope, recursively
}

interface TaskSnapshot {
  id: TaskId;
  name: string;
  kind: TaskKind;             // "io" | "llm" | "tool" | "cpu" | "custom"
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  attempt: number;
  startedAt: number;
  durationMs: number;
  progress: ProgressReport;
  meta: Record<string, unknown>;
}
```

Three properties matter:

- **Snapshot is immutable** -- taking one twice gives you two independent objects. The runtime never mutates one you already hold.
- **Snapshot is recursive** -- `scopes` is the same shape as the root, all the way down. Tools that walk it (the diagnoser, the renderer, your test assertions) share one shape.
- **Snapshot is the only public surface** -- `renderTree` consumes it, `diagnoseSnapshot` consumes it, you consume it. The hot runtime owns the live state; rich tooling lives outside core.

That's the architectural boundary that keeps core small. Anything that wants to inspect the runtime asks for a snapshot.

---

## `@workit/core/diagnostics` -- the stuck-task detector

```ts
import { diagnoseSnapshot } from "@workit/core/diagnostics";

const report = diagnoseSnapshot(scope.status(), {
  staleTaskMs: 30_000,
  events:      recentEvents,
});

if (report.findings.length > 0) {
  console.warn("agent stalled:", report.findings);
}
```

Diagnoses live, on demand, against an existing snapshot. Subpath-only so the root runtime stays small.

> **Bench [`18-diagnostics-finding-codes.mjs`](../benchmarks/articles/18-diagnostics-finding-codes.mjs).** Five hand-crafted snapshots, one per finding code.
>
> | Scenario | `report.status` | Finding codes emitted |
> |---|---|---|
> | Healthy snapshot | `ok` | (none) |
> | Task running > 30 s | `needs_attention` | `old_pending_task` |
> | Scope status `cancelling` | `needs_attention` | `scope_cancelling` |
> | Pending child scope | `needs_attention` | `pending_child_scope` + recursive `old_pending_task` |
> | `task:cleanup_timeout` event in window | `needs_attention` | `cleanup_timeout` |

Wire it to a SIGUSR1 handler in production:

```ts
process.on("SIGUSR1", () => {
  console.error(renderTree(rootScope.status()));
  console.error(JSON.stringify(diagnoseSnapshot(rootScope.status(), { staleTaskMs: 30_000 }), null, 2));
});
```

Something hangs at 3 a.m. -> one signal gives you the live tree and a list of suspicious tasks. No APM. No external service. Stderr.

---

## OpenTelemetry -- opt-in, with optional peer

```ts
import { attachOpenTelemetry } from "@workit/core/otel";

const detach = attachOpenTelemetry(scope, { tracer, meter });
```

`@opentelemetry/api` is an optional peer. The root WorkIt package stays at zero runtime dependencies. Install OTel only when you need it:

```sh
npm install @opentelemetry/api
```

If the peer is missing, `attachOpenTelemetry` throws a message that names exactly the install command -- no cryptic "cannot resolve module" trace.

---

## Three canonical configurations

```ts
// Local development -- default. No setup needed.
await run.scope(async (scope) => { /* ... */ });
// Inspect: console.log(renderTree(scope.status()))

// Production -- sampled, aggregated, budgeted, circuit-broken.
await withOTel(
  {
    exporter:       otlpExporter,
    sampling:       { mode: "errors_and_slow", slowThresholdMs: 2_000 },
    aggregation:    "per_scope",
    eventBudget:    50_000,
    redact:         ["context.user.email"],
    circuitBreaker: { failureThreshold: 10, openForMs: 300_000 },
  },
  () => agentRun(),
);
// Typical bill, 100K runs/day: ~$456/year.

// Full trace debugging: one-off, manual, full event stream.
await withOTel(
  { exporter: otlpExporter, sampling: { mode: "all" }, aggregation: "per_task" },
  () => problemReproduction(),
);
```

---

## Receipts

```sh
node benchmarks/articles/15-core-zero-network.mjs       # 0 hits in 14 dist files
node benchmarks/articles/16-sampling-and-aggregation.mjs # 1,300 -> 36 events
node benchmarks/articles/17-cardinality-safe-metrics.mjs # 2 of 5 unbounded labels rejected
node benchmarks/articles/18-diagnostics-finding-codes.mjs # 4 finding codes proven
node benchmarks/articles/run-all.mjs                    # full article suite
```

Production-side gates that back the same surface:

| Claim | Evidence |
|---|---|
| Core has zero networking imports | Static gate finds no `node:http`/`node:https`/`fetch` in `dist/index.js`. Reproduced by [`15-core-zero-network.mjs`](../benchmarks/articles/15-core-zero-network.mjs) over the full published `dist/` tree minus the explicit network-bridge subpaths. |
| Sampling reduction (`errors_and_slow` @ slowThreshold) | 100 root scopes / 5 children, >= 5x reduction asserted; measured ~36x. Production exporter stress test runs 100,000 events. |
| Aggregation collapses N tasks -> 1 record | `npm run check:exporter-stress` exercises the full summary path with bounded queue. |
| Telemetry budget never throws | Property test: any budget x any event volume -> tasks complete normally. |
| Cardinality enforcement at runtime | [`17-cardinality-safe-metrics.mjs`](../benchmarks/articles/17-cardinality-safe-metrics.mjs) verifies unbounded label keys are rejected at the wrapper boundary; adapter coverage owns enum-value validation. |
| Circuit breaker memory bound under 503 backend | `tests/perf/exporter-failure.test.ts`: < 50 MB heap growth across 1,000 scopes with backend down. |
| Diagnostics finding codes | [`18-diagnostics-finding-codes.mjs`](../benchmarks/articles/18-diagnostics-finding-codes.mjs) verifies healthy snapshots, old pending tasks, cancelling scopes, pending child scopes, and cleanup timeout findings. |
| OTel optional peer | Missing peer throws explicit install message; not a cryptic resolver error. |

---

## What's coming

You now have an agent that holds itself to a budget, releases its connections, and tells you what's happening inside without sending a byte to the cloud unless you ask.

Tomorrow: the final article. **Agent scopes and tool lifecycles.**

The same ownership tree that cancels streams and bounds observability also
governs agent tool calls, token budgets, progress events, and replayable
execution logs. The point is not a new agent framework; it is one lifecycle
contract for the agent loop and the rest of the application.

---

## Source, Benchmarks, And Evidence

- Source: https://github.com/WorkRuntime/workit
- Article source: https://github.com/WorkRuntime/workit/blob/main/articles/06-observability-without-core-bloat.md
- Reproduce: `npm run bench:articles` and `npm run test:evidence`
