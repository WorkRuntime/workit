<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Resource Safety And Budgeted Work

*Last time we showed backpressure with channels and `work().stream()` -- pausing the producer the moment the consumer slows down. This article puts hard boundaries on cost and guarantees that cleanup always runs, even when the user hits Ctrl-C, the deadline fires, or a sibling throws.*

Three primitives. One ownership tree.

- `run.bracket` -- open, use, release. Always release.
- `run.uncancellable` -- short critical sections that survive cancellation.
- Budgets -- hard caps on cost, tokens, or any metric, enforced atomically across parallel work.

No `try/finally` you'll forget to write. No "did the connection close" post-mortem.

---

## `run.bracket` -- acquire, use, release. Always release.

```ts
import { run } from "@workit/core";

const rows = await run.scope(async (scope) => scope.spawn(run.bracket(
  async () => db.connect(),                                                   // acquire
  async (conn, ctx) => conn.query("select 1", { signal: ctx.signal }),        // use
  async (conn) => conn.close(),                                                // release
  { timeout: "5s" },                                                           // bounded cleanup
)));
```

`release` runs **once** on every exit path: success, throw, parent cancel, timeout, sibling failure. The release receives the resource. The release also receives `cleanupCtx.signal` so it can give up if the cleanup itself hangs. Nested brackets release LIFO.

> **Bench [`12-bracket-vs-try-finally.mjs`](../benchmarks/articles/12-bracket-vs-try-finally.mjs).** Five scenarios -- measured.
>
> | # | Scenario | Result |
> |---|---|---|
> | A | Success path | order: `[acquire, use, release:RES-A]`, release ran exactly once |
> | B | `use` throws | order: `[acquire, use, release:RES-B]`, release runs with the resource, error propagates |
> | C | `acquire` throws | order: `[acquire]`, **release does NOT run**, error propagates |
> | D | Parent cancel during `use` | order: `[acquire, use, release:RES-D]`, outer settled `CancellationError` with `kind: "manual"` |
> | E | **Hanging release** | Native `try/finally` with a non-resolving cleanup is **still pending after 250 ms** (would deadlock forever). `run.bracket(..., { timeout: "150ms" })` settles at **t=157 ms** and emits `task:cleanup_timeout`. |

Bundle cost: **+58 B min, +15 B gzip** on `public-api`. Effectively free.

**When to use `bracket`** -- anything with a single resource that must be closed exactly once: database connections, file handles, distributed locks, HTTP client sessions, ML model contexts.

---

## `run.uncancellable` -- receipts that always commit

```ts
const receipt = run.uncancellable(async (ctx) => {
  const intent = await stripe.confirmIntent({ signal: ctx.signal });
  await db.recordReceipt({ id: intent.id }, { signal: ctx.signal });
  return intent.receipt_url;
}, { timeout: "2s" });

const url = await run.scope(async (scope) => scope.spawn(receipt));
```

The user hits Ctrl-C. The parent scope cancels. The deadline fires. Inside the shielded body, **none of those are visible** -- `ctx.signal` is a fresh signal local to the shield. The body runs to completion (or to its own `timeout`). When the shield finishes, if the parent had cancelled during the shield, the original `CancellationError` rethrows after the body completes.

Cancellation is **delayed**, not hidden.

This is the line that lets you write a Stripe webhook handler, a distributed-lock release, or a database commit without relying on ordinary task cancellation to preserve the critical section. **Bench [`08-uncancellable-shield.mjs`](../benchmarks/articles/08-uncancellable-shield.mjs)** (article 03) measured the body running 95 ms past a parent cancel before the original reason was rethrown.

**When to use `uncancellable`** -- short, critical sections that must finish atomically: Stripe charges, audit log flushes, idempotency-key writes, distributed-lock release.

> **`bracket` vs `uncancellable` decision rule:**
>
> - Use `run.bracket` when there is a **resource you opened and must close**. Cleanup is the contract; the body is just what runs in between.
> - Use `run.uncancellable` when there is **a critical section that must run to the end** even if the parent cancels. There may be no resource.
> - Use both together when a critical section needs a resource: spawn a `run.bracket` whose `use` body is a `run.uncancellable`.

`run.uncancellable` is **cooperative**. It cannot stop a non-cooperative CPU loop inside the body. For that, see article 03 -- `offload` with worker termination.

---

## Budgeted Agent Work: A 50-Cent Ceiling

```ts
import { CostBudget, group, run } from "@workit/core";

const answer = await run.context.with(
  CostBudget, { spent: 0, limit: 0.50, unit: "USD" },
  () => group(async (task) => reactLoop(task, goal)),
);
```

Inside any task body, charge with `ctx.consumeCost`:

```ts
async function callLLM(ctx, prompt) {
  const res = await openai.chat({ messages: [{ role: "user", content: prompt }] }, { signal: ctx.signal });
  ctx.consumeCost(res.usage.total_cost);   // throws + cancels owning scope on overrun
  return res;
}
```

`ctx.consumeCost(amount)` is atomic. Concurrent charges across siblings serialize through the budget cell. Overrun throws `BudgetExceededError` and cancels the **owning scope** -- the scope that set the budget, even if the charge happened five levels deeper. The cancel reason is typed: `CancelReason { kind: "budget", budgetKey, limit, spent }`.

Built-in budgets:

```ts
import { CostBudget, TokenBudget, OpenAITokens, AgentToolCalls } from "@workit/core";
```

Custom budgets:

```ts
import { createBudget } from "@workit/core";
const Anthropic = createBudget("anthropic-tokens", { unit: "tokens" });
```

> **Bench [`13-budget-atomicity-and-cancel.mjs`](../benchmarks/articles/13-budget-atomicity-and-cancel.mjs).** Three rules, measured.
>
> | Rule | Bench observation |
> |---|---|
> | Atomic concurrent charges | 100 sibling tasks each consume 0.01 from a 1.00 cap -> final spent = **1.0000...** exactly |
> | Owning scope cancellation | Budget set at depth 0; overrun attempted at depth 5; outer scope cancelled with `kind: "budget"` |
> | Caller-object immutability | After 0.5 of charges, the caller's input object stays `{ spent: 0, limit: 1, unit: "USD" }` (engine clones); live snapshot reflects the actual spend |

Three more rules complete the contract (each tracked in the production suite):

| Rule | Where it's enforced |
|---|---|
| Inner scope can shadow parent budget | Evidence coverage verifies an inner budget cell can charge independently while the outer budget remains unchanged. |
| Live read via `run.context.budget(key)` | Returns a fresh snapshot. Mutating the snapshot does not affect future reads. |
| Snapshots are `Readonly<BudgetState>` at the type | Consumer cannot mutate; engine routes mutation through `ctx.consume()` only |

---

## 100,000 documents under a token cap

```ts
import { run, group } from "@workit/core";
import { OpenAITokens, embedAll } from "@workit/core/ai";

await run.context.with(
  OpenAITokens, { spent: 0, limit: 1_000_000, unit: "tokens" },
  () => group(() => embedAll(documents, {
    concurrency: 32,
    countTokens: (doc) => doc.tokens,
    async embed(doc, ctx) {
      return openai.embed(doc.text, { signal: ctx.signal });
    },
  })),
);
```

`embedAll` is a thin helper built on `work().inParallel()` from article 02 plus `ctx.consume(OpenAITokens, count)` per item. Hit the cap mid-stream -> scope cancels with `CancelReason { kind: "budget", limit: 1_000_000, spent: 1_000_000 }`. The 32 inflight embeddings see the abort on their `ctx.signal`. Provider calls that honor the signal cancel at the transport boundary. Partial results return and no additional budget is consumed after the cap.

Tracked: `sample:embed100k` runs the full 100,000-document pipeline against a deterministic provider fixture in CI. Asserts `maxActive <= concurrency`, `finalBudget.spent === total`, `output.results.length === total`.

---

## The Context Overlay Speedup

Budgets, cancellation reasons, request scopes, idempotency keys, agent identity, deadlines -- every cross-cutting concern lives in `ContextBag`. The first-pass implementation cloned the underlying `Map` on every `.with()` call. That's quadratic when you have a deep agent stack.

The fix: an **overlay-based** context. Think of it as a linked list of single-key deltas pointing at the parent bag. `.with(key, value)` returns a child that stores one entry and points at its parent. Lookup walks up the chain. Memory and cost per `.with()` are O(1).

> **Bench [`14-context-overlay-perf.mjs`](../benchmarks/articles/14-context-overlay-perf.mjs).** 100 `.with()` calls over a 5,000-key bag.
>
> | Implementation | Wall time | Per call |
> |---|---|---|
> | Naïve clone-on-`with` (inline baseline) | **32.6 ms** | ~0.33 ms |
> | WorkIt overlay context | **0.011 ms** | ~0.0001 ms |
>
> The representative run shows a large constant-factor improvement over the inline clone baseline. Same public API. Same lookup result. The CI gate `npm run check:context-performance` asserts the overlay completes the workload in **< 10 ms** and the bench additionally asserts the inline baseline is at least 10x slower.

Evidence coverage verifies a deep shadow chain still resolves correctly and child shadows do not leak into the parent.

---

## How WorkIt compares on resource safety

| Pattern | Cancel-aware | Cleanup runs on every exit | Bounded cleanup time | Notes |
|---|---|---|---|---|
| **WorkIt `run.bracket`** | yes | yes | yes via `CleanupOpts.timeout` + `task:cleanup_timeout` event | release receives the resource and a cleanup signal |
| **WorkIt `run.uncancellable`** | yes (delayed rethrow) | n/a (it's the body, not a release) | yes via shield `timeout` | for short critical sections, not resource cleanup |
| `try { } finally { }` | no -- finally cannot run after a hard cancel; cannot be bounded | partial -- runs only if the awaiter completes settlement | no -- a hanging cleanup deadlocks | bench 12-E: still pending after 250 ms |
| ES2024 `using` / `await using` | no -- disposal hooks have no signal awareness | yes on scope exit | no -- no timeout | best when the resource has an `[Symbol.dispose]` and no cleanup timeout is required |
| Effect-TS `acquireRelease` | yes | yes | partial (no built-in timeout on release in the public surface) | richer, but inside the Effect DSL |

WorkIt is the only row that gives you cancel-aware cleanup, guaranteed-to-run release, and a **bounded timeout for the cleanup itself**, surfaced as a typed event.

---

## Receipts

```sh
node benchmarks/articles/12-bracket-vs-try-finally.mjs        # 5 bracket scenarios
node benchmarks/articles/13-budget-atomicity-and-cancel.mjs   # atomic + owning + immutable
node benchmarks/articles/14-context-overlay-perf.mjs          # 32.6 ms vs 0.011 ms
node benchmarks/articles/run-all.mjs                          # full article suite
```

Production-side gates that back the same primitives:

| Claim | Evidence |
|---|---|
| `run.bracket` scenarios | [`12-bracket-vs-try-finally.mjs`](../benchmarks/articles/12-bracket-vs-try-finally.mjs) covers success, throw, cancel, timeout, hanging cleanup, and bounded release. |
| `run.uncancellable` scenarios | [`08-uncancellable-shield.mjs`](../benchmarks/articles/08-uncancellable-shield.mjs) covers parent cancel during body, shield timeout, nested shields, and signal isolation. |
| Budget atomicity | Property test: 100 concurrent charges of 0.01 -> spent = 1.00 exactly. Reproduced by [`13-budget-atomicity-and-cancel.mjs`](../benchmarks/articles/13-budget-atomicity-and-cancel.mjs). |
| Budget snapshot immutability | [`tests/evidence/correctness/runtime-contracts.mjs`](../tests/evidence/correctness/runtime-contracts.mjs) verifies caller objects remain unchanged and snapshots are read-only views of budget state. |
| Budget owning-scope cancellation | Charge attempted at depth 5 cancels the owning scope at depth 0 with `kind: "budget"`. |
| Context overlay perf | `npm run check:context-performance` asserts < 10 ms; bench records a representative ~0.01 ms run with a large speedup over the inline baseline. |
| 100K embeddings sample | `sample:embed100k`: 100,000 docs, concurrency 32, token budget enforced, in-CI assertion. |

---

## What's coming

Now you can build an agent that costs 50 cents max, holds a database connection that always closes, and confirms a Stripe charge through a user disconnect.

Tomorrow: **observability with bounded telemetry cost.**

`scope.tree()` as a print statement for agents. The four-layer cost-control architecture -- sampling, batching, summarization, budgeting -- that takes a 100K-runs/day workload from $9,125/year of CloudWatch ingestion down to **$456/year** while preserving slow/error traces. 20x less data. One config object.

The headline: a structured-concurrency runtime where observability is **sampled, batched, summarized, and budgeted by default** -- and you opt out of cost protection, not in.

---

## Source, Benchmarks, And Evidence

- Source: https://github.com/WorkRuntime/workit
- Article source: https://github.com/WorkRuntime/workit/blob/main/articles/05-resource-safety-and-budgeted-work.md
- Reproduce: `npm run bench:articles` and `npm run test:evidence`
