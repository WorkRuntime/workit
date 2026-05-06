# WorkJS

> Structured concurrency runtime for TypeScript.
>
> Author: Admilson B. F. Cossa

WorkJS gives TypeScript applications a small, explicit runtime for owned async
work. It keeps tasks inside scopes, propagates cancellation with typed reasons,
runs cleanup before scopes close, and exposes safe task events without forcing an
effect system, generator DSL, or provider client into the application.

The package is currently private and pre-release. The implemented runtime is
verified locally, but the project should not be treated as publicly released
until the license, provenance, contribution process, and package publishing
policy are finalized.

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
} from "workjs";
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
import { embedAll, transcribeStream, wrapAI } from "workjs/ai";
import { attachTelemetryExporter } from "workjs/observability";
```

## Core Example

```ts
import { group } from "workjs";

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
import { run } from "workjs";

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
import { work } from "workjs";

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
import { CostBudget, TokenBudget, group, run } from "workjs";

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
import { embedAll } from "workjs/ai";

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
import { attachTelemetryExporter } from "workjs/observability";

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
- build plus unit tests
- bundle size limits
- runtime benchmark smoke
- scope leak smoke
- package dry run

Run coverage separately when changing behavior:

```sh
npm run test:coverage
```

Coverage thresholds are set to 100% for statements, branches, functions, and
lines. The current suite verifies 77 tests across the public runtime, run
helpers, work builder, tree rendering, budget contracts, AI helpers,
observability exporter, and executable scale examples.

The executable examples run against the compiled package and cover agent-tree
cancellation, provider racing, budget-capped RAG flow, 100K fake embeddings with
bounded concurrency, high-concurrency budget accounting, and a virtual
billion-item stream source that proves bounded production when consumers stop
early.

## Runtime Requirements

- Node.js `>=20.11`
- TypeScript `>=5.5`
- zero runtime npm dependencies
- ESM package output

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

- open-source license
- contribution guide
- security policy
- provenance and release signing
- package publishing workflow
- benchmark methodology publication
- public API stability policy

## License

No license has been selected yet.
