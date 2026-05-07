<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# WorkJS

Structured concurrency for TypeScript systems that need owned async work, cancellation, cleanup, limits, and observability.

Native `Promise` remains appropriate for one-off async values. WorkJS is intended for async work that needs ownership.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](package.json)
[![Runtime deps](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](#verified-evidence)

## Install

```sh
npm install @workjs/core
```

WorkJS currently targets Node.js server runtimes. Browser and edge runtimes resolve to an explicit unsupported-runtime boundary.

## Example

```ts
import { group } from "@workjs/core";

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

If an owned foreground task fails, WorkJS cancels sibling work, preserves the cancellation reason, and runs registered cleanup before the scope closes.

## Why WorkJS Exists

JavaScript promises model async values. They do not model ownership.

In production systems, async work often needs more than `Promise.all()`:

| Requirement | Raw Promise | WorkJS |
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

Use WorkJS when:

- multiple async tasks belong to one operation
- child failures should cancel sibling work
- cleanup must run before returning
- provider calls need timeout, retry, fallback, or racing
- batch work needs bounded concurrency and partial-result policy
- tool execution needs token, cost, or call budgets
- task events must be observable without leaking provider internals

Do not use WorkJS when:

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
| Unit tests | 210 tests passing |
| Coverage | 100% statements, branches, functions, lines |
| Runtime dependencies | 0 production dependencies |
| Public API exports | 7 locked package export paths |
| Public bundle | 29,275 B minified / 9,696 B gzip |
| Core group import | 14,195 B minified / 4,839 B gzip |
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
} from "@workjs/core";
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
import { run } from "@workjs/core";

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

## Resource Safety

```ts
import { run } from "@workjs/core";

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
import { run } from "@workjs/core";

const commit = run.uncancellable(async (ctx) => {
  await writeFinalReceipt({ signal: ctx.signal });
}, { timeout: "2s" });
```

`run.uncancellable()` delays parent cancellation while the protected body runs, but it does not hide cancellation. If the parent was cancelled during the shielded section, WorkJS rethrows the original cancellation after the section completes.

JavaScript cannot forcibly stop non-cooperative in-process work. For hard CPU boundaries, use worker offload with a timeout.

## Work Builder

```ts
import { work } from "@workjs/core";

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
import { CostBudget, TokenBudget, group, run } from "@workjs/core";

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
import { diagnoseSnapshot } from "@workjs/core/diagnostics";

const report = diagnoseSnapshot(scope.status(), {
  staleTaskMs: 30_000,
  events: recentEvents,
});
```

Diagnostics are subpath-only to keep the root runtime small. Reports identify old pending tasks, cleanup timeouts, cancelling scopes, and pending child scopes.

## Channels

```ts
import { createChannel } from "@workjs/core/channel";

const channel = createChannel<string>({ capacity: 16 });

await channel.send("item");
const item = await channel.receive();
```

Channels provide bounded in-process backpressure with close and cancellation semantics.

## AI Helpers

```ts
import { runAgent, streamLLM } from "@workjs/core/ai";

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
import { attachTelemetryExporter } from "@workjs/core/observability";

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
import { attachOpenTelemetry } from "@workjs/core/otel";
```

`@opentelemetry/api` is an optional peer dependency.

## Worker Offload Boundary

```ts
import { offload } from "@workjs/core/worker";

const result = await offload(
  new URL("./cpu-worker.js", import.meta.url),
  "fibonacci",
  42,
  { timeout: "2s" }
);
```

Worker modules must be local application-controlled files. WorkJS rejects remote URLs, inline URLs, empty module references, and parent directory segments before the worker imports anything.

Accepted worker inputs include primitives, arrays, plain objects, `Map`, `Set`, `Date`, `RegExp`, `ArrayBuffer`, `SharedArrayBuffer`, and typed array views.

Rejected worker inputs include functions, symbols, class instances, objects with custom prototypes, remote module URLs, inline module URLs, and traversal paths.

## Examples

After build:

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

These samples run against the compiled package.

## Migration Notes

### From native Promise

Keep native promises for simple async values. Use WorkJS when the work needs ownership, cancellation, cleanup, bounded concurrency, budgets, diagnostics, or observability.

### From p-limit

Use `run.pool()` when bounded concurrency also needs scope ownership and cancellation. Keep `p-limit` for a tiny standalone semaphore.

### From p-map

Use `work(items).inParallel(n).do(fn)` when mapping needs retry, timeout, item-level error policy, or streaming.

### From RxJS

Keep RxJS for rich observable transformation graphs. Use WorkJS for owned async work and task lifecycle control.

### From Bottleneck

Keep Bottleneck for distributed rate limits and reservoirs. Use WorkJS for local structured concurrency.

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

The package remains private until final publication approval.

## Contributing

Please read `CONTRIBUTING.md` before opening a pull request.

Before submitting code:

```sh
npm run verify
npm run test:coverage
```

Bug reports should include the WorkJS version, Node.js version, reproduction code, and whether the failure occurs from source or the installed package.

Security reports should follow `SECURITY.md`.

## License

Apache-2.0. See `LICENSE`.
