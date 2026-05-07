<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->
# WorkJS

> Structured concurrency runtime for TypeScript.
>
> Author: Admilson B. F. Cossa

WorkJS gives TypeScript applications a small, explicit runtime for owned async
work. It keeps tasks inside scopes, propagates cancellation with typed reasons,
runs cleanup before scopes close, and exposes safe task events without forcing an
effect system, generator DSL, or provider client into the application.

The package is private and pre-release. The implemented Node.js server runtime
is verified locally, but the project should not be treated as publicly released
until the package identity, public API stability policy, and release operations
are finalized.

## Why It Exists

Raw promises make it easy to start work that nobody owns. That is painful in
systems that need retries, budgets, cancellation, provider fallbacks, telemetry,
and cleanup to behave as one unit.

WorkJS is built for:

- agent task trees
- RAG ingestion
- embedding batches
- streaming transcription
- multi-provider races
- queue and API orchestration
- budget-aware background work
- cancellation-safe tool execution

## Guarantees

The current engine is designed around these production guarantees:

- every non-detached task belongs to exactly one scope
- a scope waits for owned children before closing
- scope cancellation aborts children through `AbortSignal`
- non-background child failure cancels sibling work
- deferred cleanup runs in last-in, first-out order
- context and budgets inherit through child scopes with explicit shadowing
- task and scope transitions are emitted as typed local events
- telemetry export is opt-in, sampled, and circuit-broken
- provider helpers are neutral and import no network clients

## Public Surface

```ts
import {
  group,
  run,
  work,
  renderTree,
  createBudget,
  createContextKey,
  CostBudget,
  TelemetryBudget,
  TokenBudget,
  LatencyBudget,
} from "@workjs/core";
```

| Export | Purpose |
| --- | --- |
| `group()` | Opens an owned scope and runs scoped tasks. |
| `run` | Composition helpers for all, race, any, pool, timeout, retry, hedge, fallback, circuit breaker, detached, background, and supervise. |
| `work()` | Fluent batch builder with bounded concurrency, retry, timeout, filtering, mapping, collection, and stream output. |
| `renderTree()` | Renders a scope snapshot into a stable text tree for diagnostics. |
| `createContextKey()` | Creates typed context keys for scope-local values. |
| `createBudget()` | Creates typed budget keys for cost, telemetry, token, latency, or application budgets. |

Subpath exports:

```ts
import { embedAll, transcribeStream, wrapAI } from "@workjs/core/ai";
import { attachTelemetryExporter } from "@workjs/core/observability";
import { attachOpenTelemetry } from "@workjs/core/otel";
```

## Core Example

```ts
import { group } from "@workjs/core";

const result = await group(async (task) => {
  const profile = task(async (ctx) => {
    return await fetchProfile(ctx.signal);
  }, { name: "profile.load" });

  const account = task(async (ctx) => {
    return await fetchAccount(ctx.signal);
  }, { name: "account.load" });

  task.background(async (ctx) => {
    ctx.defer(() => flushAuditBuffer());
    await writeAuditEvent(ctx.signal);
  }, { name: "audit.write" });

  return {
    profile: await profile,
    account: await account,
  };
});
```

If either owned child fails, the scope cancels sibling work and still runs
registered cleanup before returning or throwing.

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

`run.race()` and `run.any()` cancel losing work. `run.pool()` preserves result
order while bounding concurrency. Retry, timeout, hedge, fallback, and circuit
breaker helpers are task wrappers, so they compose without leaving the scope
model.

## Work Builder

```ts
import { work } from "@workjs/core";

const output = await work(documents)
  .inParallel(8)
  .withRetry({ times: 3, backoff: "exponential" })
  .withTimeout("5s")
  .filter((doc) => doc.enabled)
  .map(async (doc, ctx) => {
    return await embedDocument(doc, ctx.signal);
  })
  .onError("collect")
  .do((embedding) => embedding);
```

The builder defaults to sequential, fail-fast execution. Concurrency, retry,
timeouts, and error collection are explicit choices.

## Budgets And Context

```ts
import { CostBudget, TokenBudget, group, run } from "@workjs/core";

await run.context.with(CostBudget, { spent: 0, limit: 100 }, async () =>
  run.context.with(TokenBudget, { spent: 0, limit: 10_000 }, async () =>
    group(async (task) => {
      await task(async (ctx) => {
        ctx.consume(CostBudget, 25);
        ctx.consume(TokenBudget, 1_200);
        return await callModel(ctx.signal);
      });
    })
  )
);
```

Cost-like budgets fail loudly when exhausted. Telemetry budgets drop events
instead of failing application work. Child scopes inherit budgets unless they
explicitly provide a replacement budget.

## AI Helpers

```ts
import { embedAll } from "@workjs/core/ai";

const embeddings = await embedAll(chunks, {
  countTokens: (chunk) => chunk.tokenCount,
  embed: async (chunk, ctx) => {
    return await provider.embed(chunk.text, { signal: ctx.signal });
  },
}, {
  concurrency: 4,
  timeout: "10s",
  onError: "collect",
});
```

The AI subpath supplies contracts and structured execution helpers only. It does
not import OpenAI, Anthropic, cloud SDKs, HTTP clients, or any other provider
runtime.

## Observability Export

```ts
import { attachTelemetryExporter } from "@workjs/core/observability";

const attachment = attachTelemetryExporter(scope, async (event) => {
  await telemetry.write(event);
}, {
  sampling: { mode: "errors_and_slow", slowThresholdMs: 2_000 },
  circuitBreaker: { failureThreshold: 3, openForMs: 60_000 },
});

attachment.unsubscribe();
```

The core event bus is local and dependency-free. Exporting events to another
system is explicit, sampled, and protected by a small circuit breaker so telemetry
backend failures do not take down application work.

## Quality Gates

Run the full local gate before staging production changes:

```sh
npm run verify
```

`npm run verify` runs:

- TypeScript typecheck
- no-network import guard
- static security scan
- production vulnerability audit
- SBOM validation
- build plus unit tests
- API surface lock
- bundle size limits
- runtime benchmark smoke
- one-billion logical item benchmark
- scope leak smoke
- exporter-down stress test
- installed-package compatibility fixtures
- executable claim fixtures
- release provenance workflow policy check
- package dry run

Run coverage separately when changing behavior:

```sh
npm run test:coverage
```

Coverage thresholds are set to 100% for statements, branches, functions, and
lines. The current suite verifies 137 tests across the public runtime, run
helpers, work builder, tree rendering, budget contracts, AI helpers,
observability exporter, and executable scale examples.

The executable examples run against the compiled package and cover agent-tree
cancellation, provider racing, budget-capped RAG flow, 100K fake embeddings with
bounded concurrency, high-concurrency budget accounting, and a virtual
billion-item stream source that proves bounded production when consumers stop
early.

## Public Proof

Machine-readable public proof lives in `benchmarks/public-proof.json`. It links
benchmark fixtures, stream and soak gates, package-consumer checks, executable
claim fixtures, migration guides, and the runtime compatibility matrix to the
commands that verify them.

The public proof gate is:

```sh
npm run check:public-proof
```

This gate does not replace the benchmarks. It prevents the proof artifact and
README from drifting away from the executable verification commands.

## Migration Guides

### From p-limit

Use `run.pool(concurrency, tasks)` when you want bounded concurrency plus scope
ownership, cancellation, cleanup, and result ordering. Keep `p-limit` if all you
need is one small local semaphore and you do not need owned task trees.

```ts
const results = await run.pool(8, items.map((item) => async (ctx) => {
  return await processItem(item, ctx.signal);
}));
```

### From p-map

Use `work(items).inParallel(n).do(fn)` when mapping needs retry, timeout, item
errors, progress, or stream output. Use `onError("continue")` or
`onError("collect")` when partial batch results are part of the contract.

```ts
const output = await work(items)
  .inParallel(8)
  .withRetry(3)
  .onError("continue")
  .do(async (item, ctx) => transform(item, ctx.signal));
```

### From RxJS

Keep RxJS for rich observable transformation graphs. Use WorkJS when the problem
is owned async work: scoped cancellation, cleanup, bounded provider calls,
budgets, and task events. For stream-shaped provider work, start with
`work(...).stream()` or the `/ai` stream helpers.

### From Bottleneck

Keep Bottleneck for distributed rate limits, reservoirs, and cluster-aware
throttling. Use WorkJS for local structured concurrency with per-scope ownership,
retry, timeout, and cleanup. Combine them by calling Bottleneck inside a WorkJS
task when distributed rate policy is required.

Visible sample scripts are available after build:

```sh
npm run sample:1b
npm run sample:concurrency
npm run sample:progress
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
npm run sample:supervise
npm run sample:worker
npm run sample:aws
npm run sample:azure
npm run sample:next
npm run sample:otel
npm run sample:logging
```

`sample:logging` demonstrates adapting WorkJS task log events to OTel-shaped log
records without importing OpenTelemetry into the core package. `@workjs/core/otel` is
an opt-in adapter subpath with `@opentelemetry/api` as an optional peer; the root
runtime remains local-first and dependency-free.

`sample:worker` demonstrates explicit CPU offload through `@workjs/core/worker`.
WorkJS does not automatically route `kind: "cpu"` tasks to workers; worker
execution is an explicit opt-in. Use `run.uncancellable(task, { timeout })` for
short, signal-aware in-process shields. Use `offload(module, exportName, input,
{ timeout })` when non-cooperative CPU work needs a hard worker-thread lifetime
boundary.

## Runtime Requirements

- Node.js `>=20.11`
- TypeScript `>=5.5`
- zero runtime npm dependencies
- ESM and CommonJS package output

## Runtime Support

Supported today:

- Node.js `>=20.11` server runtimes
- ESM consumers from the installed package
- CommonJS consumers from the installed package
- strict TypeScript consumers
- local Bun and Deno package-import smoke tests
- AWS Lambda, Azure Functions, Next.js route, Express, Fastify, tRPC, and
  Vercel AI SDK handler-shaped local fixtures

Not supported today:

- browser client execution
- Cloudflare Worker execution
- Next.js Edge or Vercel Edge execution

Browser and Cloudflare Worker checks currently prove only the safe
unsupported-runtime boundary: bundles resolve to an explicit unsupported runtime
and do not pull in Node-only WorkJS modules. Real browser/edge support requires
a dedicated edge-safe engine and separate semantic tests before it can be
claimed.

## Repository Hygiene

Committed source, tests, scripts, and package metadata include
language-appropriate documentation and author metadata where the format supports
it.

Generated output, dependency folders, private planning notes, temporary tests,
debug traces, scratch reproductions, and environment files are intentionally
excluded from version control.

Commits should be scoped, imperative, and made only after the related tests and
gates are green.

## Release Status

WorkJS is not ready for public release until these decisions are complete:

- npm scope ownership; the package identity is `@workjs/core`, while the
  unscoped `workjs` name already exists on npm
- benchmark methodology publication
- public API stability policy

The repository contains a provenance-enabled release workflow and a local
release-policy gate. `npm run check:release` intentionally fails while
`package.json` remains private. Final publication requires a separate scoped
release commit after the remaining evaluations are complete.

## License

Apache-2.0.
