<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# WorkIt

Structured concurrency for TypeScript systems that need owned async work, cancellation, cleanup, limits, and observability.

Native `Promise` remains appropriate for one-off async values. WorkIt is intended for async work that needs ownership.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](package.json)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](#verified-evidence)

## Install

```sh
npm install @workit/core
```

WorkIt currently targets Node.js server runtimes. Browser and edge runtimes resolve to an explicit unsupported-runtime boundary.

## Guide

Use WorkIt by choosing the smallest primitive that owns the work you need:

| Need | Use |
| --- | --- |
| One operation with child tasks | `group(async (task) => ...)` |
| A few task functions together | `run.all()`, `run.race()`, `run.any()`, `run.series()` |
| Bounded concurrency with ordered results | `run.pool(concurrency, tasks)` |
| Batch transforms over items | `work(items).inParallel(n).do(fn)` |
| Retry, timeout, fallback, or resource cleanup | `run.retry()`, `run.timeout()`, `run.fallback()`, `run.bracket()` |
| Streaming batches with backpressure | `work(items).stream()` |
| Producer-consumer coordination | `@workit/core/channel` |
| Snapshot diagnosis | `@workit/core/diagnostics` |
| AI tool/budget helper contracts | `@workit/core/ai` |
| OpenTelemetry bridge | `@workit/core/otel` |
| CPU or non-cooperative work boundary | `@workit/core/worker` |

The main rule is: keep native `Promise` for single async values, and use WorkIt when the operation needs ownership, cancellation, cleanup, bounded concurrency, budgets, diagnostics, or observable task events.

## Example

```ts
import { group } from "@workit/core";

const result = await group(async (task) => {
  const profile = task(async (ctx) => {
    return await fetchProfile({ signal: ctx.signal });
  }, { name: "profile.load" });

  const account = task(async (ctx) => {
    return await fetchAccount({ signal: ctx.signal });
  }, { name: "account.load" });

  task.background(async (ctx) => {
    ctx.defer(() => flushAuditBuffer());
    await writeAuditEvent({ signal: ctx.signal });
  }, { name: "audit.write" });

  return {
    profile: await profile,
    account: await account,
  };
});
```

If an owned foreground task fails, WorkIt cancels sibling work, preserves the cancellation reason, and runs registered cleanup before the scope closes.

## Why WorkIt Exists

JavaScript promises model async values. They do not model ownership.

In production systems, async work often needs more than `Promise.all()`:

| Requirement | Raw Promise | WorkIt |
| --- | --- | --- |
| Owned task tree | Manual implementation | Provided by scope model |
| Cancel siblings on failure | Manual implementation | Scope cancellation |
| Typed cancellation reason | Manual implementation | `CancelReason` |
| Cleanup before scope closes | Manual implementation | `ctx.defer()` |
| Bounded concurrency | External helper or custom queue | `run.pool()` and `work().inParallel()` |
| Retry and timeout composition | Manual implementation | Task wrappers |
| Budget accounting | Manual implementation | Context budgets |
| Diagnostics | Manual implementation | Snapshot diagnostics |
| Safe telemetry export | Manual | Opt-in |

Typical use cases include backend orchestration, agent task trees, RAG ingestion, provider races, batch processing, streaming transcription, worker offload, and cancellation-safe tool execution.

## Use Cases And Non-Goals

Use WorkIt when:

- multiple async tasks belong to one operation
- child failures should cancel sibling work
- cleanup must run before returning
- provider calls need timeout, retry, fallback, or racing
- batch work needs bounded concurrency and partial-result policy
- tool execution needs token, cost, or call budgets
- task events must be observable without leaking provider internals

Do not use WorkIt when:

- a single `await fetch()` is enough
- you only need a tiny local semaphore
- you need distributed rate limiting or cluster reservoirs
- you need browser or edge runtime support today
- your task body cannot cooperate with cancellation and cannot be moved to a worker

## Guarantees

The Node.js runtime is designed around these contracts:

- every non-detached task belongs to exactly one scope
- scopes wait for owned children before closing
- scope cancellation propagates through `AbortSignal`
- non-background child failure cancels sibling work
- deferred cleanup runs in last-in, first-out order
- retry sleeps and rate-limit waits remove abort listeners
- idempotency handles are pruned after task settlement
- `run.any()` and `run.race()` preserve parent cancellation reasons
- cleanup failures emit typed cleanup events
- budgets inherit through scope context with explicit shadowing
- telemetry export is opt-in, sampled, bounded, and circuit-broken
- worker offload rejects remote URLs, inline URLs, traversal paths, functions, symbols, and class instances

## Verified Evidence

The repository contains executable gates for runtime behavior, package behavior, supply-chain policy, and scale smoke tests.

Current verification evidence:

| Gate | Result |
| --- | --- |
| Unit tests | 214 tests passing |
| Coverage | 100% statements, branches, functions, lines |
| Runtime dependencies | 0 production dependencies |
| Public API exports | 7 locked package export paths |
| Public bundle | 29,255 B minified / 9,694 B gzip |
| Core group import | 14,175 B minified / 4,835 B gzip |
| Soak | 100,000 logical tasks, bounded concurrency |
| Stream memory | 1,000,000 logical items, bounded producer growth |
| Exporter stress | 100,000 events with bounded queue |
| Package consumer | ESM, CJS, TypeScript, framework fixtures |
| Security | headers, no-network, vulnerability, SBOM, release-policy gates |

Run the full gate:

```sh
npm run verify
```

Run coverage:

```sh
npm run test:coverage
```

Run public proof validation:

```sh
npm run check:public-proof
```

Machine-readable reviewer evidence lives in `benchmarks/public-proof.json`. The public proof gate keeps that artifact aligned with the README, benchmark fixtures, migration guides, and runtime matrix.

## Core API

```ts
import {
  group,
  run,
  work,
  renderTree,
  createBudget,
  createContextKey,
  CostBudget,
  TokenBudget,
  TelemetryBudget,
} from "@workit/core";
```

| Export | Purpose |
| --- | --- |
| `group()` | Opens an owned task scope. |
| `run` | Task combinators: all, race, any, pool, retry, timeout, fallback, bracket, bounded shields, and execution helpers. |
| `work()` | Batch builder with concurrency, retry, timeout, filtering, mapping, error policy, and streaming. |
| `renderTree()` | Stable text rendering for scope snapshots. |
| `createContextKey()` | Typed context keys. |
| `createBudget()` | Typed cooperative budget keys. |

## Run Helpers

```ts
import { run } from "@workit/core";

const fastest = await run.race([
  run.timeout(callPrimary, "800ms"),
  run.timeout(callReplica, "800ms"),
]);

const resilient = run.fallback(
  run.retry(callProvider, { times: 3, backoff: "exponential" }),
  callBackupProvider
);

const batch = await run.pool(8, inputs.map((input) => async (ctx) => {
  return await processInput(input, ctx.signal);
}));
```

`run.race()` and `run.any()` cancel losing work. `run.pool()` preserves result order while bounding concurrency.

## Retry Policy

Retry defaults are resilience-oriented, not micro-benchmark-oriented.

Both `run.retry(task, 3)` and `work(items).withRetry(3)` normalize to:

```ts
{
  times: 3,
  backoff: "exponential",
  initialDelay: 100,
  maxDelay: 30_000,
  jitter: true,
}
```

`times` is the maximum number of attempts including the first attempt. With `times: 3`, WorkIt can run one initial attempt and two retries.

Use the numeric form for production calls where brief backoff is desired:

```ts
const resilient = run.retry(callProvider, 3);
```

Use an explicit zero-delay policy for local operations, tests, or fast in-memory retries:

```ts
const fast = run.retry(callLocalCache, {
  times: 3,
  initialDelay: "0ms",
  maxDelay: "0ms",
  jitter: false,
});

const output = await work(items)
  .withRetry({
    times: 3,
    initialDelay: "0ms",
    maxDelay: "0ms",
    jitter: false,
  })
  .do(async (item) => processItem(item));
```

Use `retryIf` to keep retry policy explicit:

```ts
const providerCall = run.retry(callProvider, {
  times: 4,
  backoff: "exponential",
  initialDelay: "200ms",
  maxDelay: "5s",
  retryIf: (err) => isTransientProviderError(err),
});
```

Do not use retry to hide deterministic validation errors. Reject those at the boundary.

## Resource Safety

```ts
import { run } from "@workit/core";

await run.bracket(
  async () => await openConnection(),
  async (connection, ctx) => {
    return await connection.query("select 1", { signal: ctx.signal });
  },
  async (connection) => {
    await connection.close();
  }
);
```

`run.bracket()` releases exactly once on success, error, timeout, and cancellation.

## Bounded Uncancellable Sections

```ts
import { run } from "@workit/core";

const commit = run.uncancellable(async (ctx) => {
  await writeFinalReceipt({ signal: ctx.signal });
}, { timeout: "2s" });
```

`run.uncancellable()` delays parent cancellation while the protected body runs, but it does not hide cancellation. If the parent was cancelled during the shielded section, WorkIt rethrows the original cancellation after the section completes.

JavaScript cannot forcibly stop non-cooperative in-process work. For hard CPU boundaries, use worker offload with a timeout.

## Work Builder

```ts
import { work } from "@workit/core";

const output = await work(documents)
  .inParallel(8)
  .withRetry({ times: 3, backoff: "exponential" })
  .withTimeout("5s")
  .filter((doc) => doc.enabled)
  .onError("collect")
  .do(async (doc, ctx) => {
    return await embedDocument(doc, { signal: ctx.signal });
  });
```

The builder defaults to sequential, fail-fast execution. Concurrency and partial-result policy are explicit.

## Budgets And Context

```ts
import { CostBudget, TokenBudget, group, run } from "@workit/core";

await run.context.with(CostBudget, { spent: 0, limit: 100, unit: "USD" }, async () =>
  run.context.with(TokenBudget, { spent: 0, limit: 10_000, unit: "tokens" }, async () =>
    group(async (task) => {
      await task(async (ctx) => {
        ctx.consume(CostBudget, 25);
        ctx.consume(TokenBudget, 1_200);
        return await callModel({ signal: ctx.signal });
      });
    })
  )
);
```

Budget snapshots exposed to consumers are readonly. Mutation happens through `ctx.consume()`.

## Diagnostics

```ts
import { diagnoseSnapshot } from "@workit/core/diagnostics";

const report = diagnoseSnapshot(scope.status(), {
  staleTaskMs: 30_000,
  events: recentEvents,
});
```

Diagnostics are subpath-only to keep the root runtime small. Reports identify old pending tasks, cleanup timeouts, cancelling scopes, and pending child scopes.

## Channels

```ts
import { createChannel } from "@workit/core/channel";

const channel = createChannel<string>({ capacity: 16 });

await channel.send("item");
const item = await channel.receive();
```

Channels provide bounded in-process backpressure with close and cancellation semantics.

## AI Helpers

```ts
import { runAgent, streamLLM } from "@workit/core/ai";

const result = await runAgent(async (agent) => {
  return await agent.tool("search", { q: "structured concurrency" }, async (input, ctx) => {
    return await search(input.q, { signal: ctx.signal });
  }, {
    timeout: "5s",
    tokens: 12,
    toolCalls: 1,
  });
});
```

The AI subpath supplies contracts and structured execution helpers only. It does not import OpenAI, Anthropic, cloud SDKs, HTTP clients, or provider runtimes.

## Observability

```ts
import { attachTelemetryExporter } from "@workit/core/observability";

const attachment = attachTelemetryExporter(scope, async (event) => {
  await telemetry.write(event);
}, {
  sampling: { mode: "errors_and_slow", slowThresholdMs: 2_000 },
  circuitBreaker: { failureThreshold: 3, openForMs: 60_000 },
  sanitize: (event) => event,
});

attachment.unsubscribe();
```

The root event bus is local and dependency-free. Exporting events is explicit, sampled, bounded, sanitized, and circuit-broken.

OpenTelemetry integration is opt-in:

```ts
import { attachOpenTelemetry } from "@workit/core/otel";
```

`@opentelemetry/api` is an optional peer dependency so the root package can stay dependency-free. Install it only when using the OTel subpath:

```sh
npm install @opentelemetry/api
```

If the peer is missing and `attachOpenTelemetry()` needs the default OTel API, WorkIt throws:

```txt
To use @workit/core/otel, install:
npm install @opentelemetry/api
```

You may also pass explicit `tracer` and `meter` objects for tests or custom OTel wiring.

## Worker Offload Boundary

```ts
import { offload } from "@workit/core/worker";

const result = await offload(
  new URL("./cpu-worker.js", import.meta.url),
  "fibonacci",
  42,
  { timeout: "2s" }
);
```

Worker modules must be local application-controlled files. WorkIt rejects remote URLs, inline URLs, empty module references, and parent directory segments before the worker imports anything.

Accepted worker inputs include primitives, arrays, plain objects, `Map`, `Set`, `Date`, `RegExp`, `ArrayBuffer`, `SharedArrayBuffer`, and typed array views.

Rejected worker inputs include functions, symbols, class instances, objects with custom prototypes, remote module URLs, inline module URLs, and traversal paths.

## Examples Index

Samples run against the compiled package:

```sh
npm run sample:1b
npm run sample:concurrency
npm run sample:cancel
npm run sample:timeout
npm run sample:no-orphan
npm run sample:all
npm run sample:agent
npm run sample:race
npm run sample:rag
npm run sample:batch
npm run sample:stream
npm run sample:embed100k
npm run sample:bisection
npm run sample:stt-disconnect
npm run sample:worker
npm run sample:aws
npm run sample:azure
npm run sample:next
npm run sample:otel
npm run sample:logging
```

| Sample | Scenario |
| --- | --- |
| `sample:all` | Safer `Promise.all()` replacement with sibling cancellation and cleanup. |
| `sample:concurrency` | Bounded parallelism with budget consumption. |
| `sample:cancel` | Typed cancellation reason propagation. |
| `sample:timeout` | Timeout-driven cancellation. |
| `sample:no-orphan` | Scope ownership preventing orphaned child work. |
| `sample:agent` | Agent-style task tree cancellation. |
| `sample:race` | Provider race with loser cancellation. |
| `sample:rag` | RAG-style budgeted work. |
| `sample:batch` | Batch upload with retry and partial-result handling. |
| `sample:stream` | Streaming summarizer with bounded work. |
| `sample:embed100k` | 100,000 logical embedding tasks. |
| `sample:bisection` | Batch bisection for partial provider failures. |
| `sample:stt-disconnect` | Speech-to-text cancellation on disconnect. |
| `sample:worker` | Worker offload for CPU/non-cooperative work. |
| `sample:aws` | AWS Lambda-shaped handler. |
| `sample:azure` | Azure Functions-shaped handler. |
| `sample:next` | Next.js route-shaped handler. |
| `sample:otel` | OpenTelemetry adapter use. |
| `sample:logging` | Logging-to-telemetry bridge. |

## Benchmarks And Reproducibility

WorkIt benchmark claims are tied to executable gates in the repository. They are release checks, not synthetic marketing numbers.

| Command | What it validates |
| --- | --- |
| `npm run check:benchmark` | Basic runtime throughput for `group()` and `run.all()`. |
| `npm run check:1b` | One-billion logical item streaming shape with bounded concurrency. |
| `npm run check:stream-memory` | Slow-consumer stream memory ceiling and producer backpressure. |
| `npm run check:soak` | 100,000 logical task runtime soak. |
| `npm run check:exporter-stress` | Bounded telemetry exporter behavior under high event volume. |
| `npm run check:package-consumer` | Installed package behavior across ESM, CJS, TypeScript, framework fixtures, browser bundle split, and Cloudflare dry-run unsupported boundary. |
| `npm run check:claims` | Executable claim fixtures derived from review findings. |

Run all public proof gates:

```sh
npm run verify
```

Run only the public proof artifact gate:

```sh
npm run check:public-proof
```

The static proof artifact is `benchmarks/public-proof.json`. It records evidence commands, benchmark fixture thresholds, migration-guide coverage, and runtime matrix rows.

When comparing WorkIt with another library, keep the comparison scoped:

- compare raw throughput only for equivalent operations
- include cancellation, cleanup, and ownership when those are part of the requirement
- report Node.js version, operating system, CPU, command, iteration count, concurrency, and heap flags
- use `--expose-gc` for memory gates that require explicit garbage collection
- do not compare a structured runtime against a semaphore without naming the semantic difference

## WorkIt Compared With Common Alternatives

| Tool | Primary model | Use it when | Use WorkIt when |
| --- | --- | --- | --- |
| Native `Promise` | Async value | One async value or a small local composition is enough. | The operation needs ownership, cancellation, cleanup, or diagnostics. |
| `p-limit` | Local concurrency limiter | You only need a tiny semaphore. | Bounded work also needs scope ownership, cancellation, retry, timeout, or task events. |
| `p-map` | Concurrent mapping | You need a focused map helper. | Mapping also needs retry, timeout, stream policy, budgets, or partial-result contracts. |
| RxJS | Observable transformation graph | You are modeling rich event streams and operators. | You are modeling owned async task lifecycles. |
| Bottleneck | Rate limiting and reservoirs | You need distributed or reservoir-based rate limiting. | You need local structured concurrency and lifecycle control. |

WorkIt is not a replacement for every async library. It is a structured-concurrency runtime for owned work. The correct choice depends on whether lifecycle semantics are part of the problem.

## Migration Notes

### From native Promise

Keep native promises for simple async values. Use WorkIt when the work needs ownership, cancellation, cleanup, bounded concurrency, budgets, diagnostics, or observability.

### From p-limit

Use `run.pool()` when bounded concurrency also needs scope ownership and cancellation. Keep `p-limit` for a tiny standalone semaphore.

### From p-map

Use `work(items).inParallel(n).do(fn)` when mapping needs retry, timeout, item-level error policy, or streaming.

### From RxJS

Keep RxJS for rich observable transformation graphs. Use WorkIt for owned async work and task lifecycle control.

### From Bottleneck

Keep Bottleneck for distributed rate limits and reservoirs. Use WorkIt for local structured concurrency.

## Runtime Support

Supported:

- Node.js `>=20.11`
- ESM consumers
- CommonJS consumers
- strict TypeScript consumers
- AWS Lambda-shaped handlers
- Azure Functions-shaped handlers
- Next.js route-shaped handlers
- Express, Fastify, tRPC, and Vercel AI SDK fixtures

Unsupported today:

- browser client runtime
- Cloudflare Workers
- Next.js Edge / Vercel Edge

Unsupported runtimes resolve to an explicit unsupported boundary.

## Security And Release Integrity

The repository includes gates for:

- author and SPDX headers
- no runtime network clients in core
- no install lifecycle scripts
- pinned dev dependencies
- production vulnerability audit
- SBOM validation
- API surface lock
- bundle-size lock
- package-consumer fixtures
- release provenance workflow validation
- SHA-pinned GitHub Actions
- OSSF Scorecard workflow
- CODEOWNERS
- Dependabot
- signed release tag policy

## Contributing

Please read `CONTRIBUTING.md` before opening a pull request.

Before submitting code:

```sh
npm run verify
npm run test:coverage
```

Bug reports should include the WorkIt version, Node.js version, reproduction code, and whether the failure occurs from source or the installed package.

Security reports should follow `SECURITY.md`.

## License

Apache-2.0. See `LICENSE`.
