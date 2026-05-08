<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Concurrency, Retry, And Timeout Under One Owner

Last time we showed `work(items).inParallel(8).withRetry(3).withTimeout("5s").do(fn)` -- the one-line fluent surface for processing a list. That handles the 80% case.

This article is about the other 20%: orchestrating heterogeneous tasks that race, fall back, hedge, and retry -- **with ownership**.

Open `package.json` in many AI codebases and you'll find some subset of:

```json
"p-limit":      "^5.0.0",
"p-map":        "^7.0.0",
"p-retry":      "^6.2.0",
"p-timeout":    "^6.1.2",
"p-queue":      "^8.0.1",
"bottleneck":   "^2.19.5",
"async-retry":  "^1.3.3"
```

Six libraries. Six lifecycles. Some expose cancellation hooks. None of them gives the whole tree one ownership contract by default. When a sibling throws, when a timeout fires, when the user hits stop, you have to stitch together queue state, retry delay, timeout wrapper, underlying I/O, cleanup, and error shape yourself.

That is the comparison in this article: not "those tools are useless", but "they are separate primitives." WorkIt's claim is ownership and composition. The runnable benches at the end of each section verify the WorkIt invariants on your machine.

WorkIt has five core composables, all sharing one runtime contract:

```ts
run.all      // Promise.all that actually cancels losers on first failure.
run.race     // Promise.race that actually cancels losers.
run.any      // Promise.any that actually cancels remaining tasks.
run.pool     // p-limit + p-map, but children belong to the scope.
run.series   // sequential, with shared cancellation.
```

Plus four more that compose with them:

```ts
run.retry    // backoff with signal-aware sleep.
run.timeout  // deadline that returns a TaskFn.
run.fallback // primary -> secondary, type-safe.
run.hedge    // bounded speculative execution for tail-latency control.
```

Same familiar names. Different runtime contract: **everything below the call belongs to a scope, and the scope owns the cancel.**

The composition property under all nine: every WorkIt resilience helper takes a `TaskFn<T>` and returns a `TaskFn<T>`. That makes the algebra closed -- `run.timeout(run.retry(callProvider, 3), "5s")` is just function composition. Promise helpers usually return promises or independent wrapper functions, so crossing from timeout to retry to race means you own the glue and the signal threading.

---

## `run.all` -- the safer Promise.all

```ts
import { run } from "@workit/core";

const [profile, plan, sources] = await run.all([
  (ctx) => fetchProfile({ signal: ctx.signal }),
  (ctx) => planLLM(question, { signal: ctx.signal }),
  (ctx) => retrieveContext(question, { signal: ctx.signal }),
]);
```

`Promise.all` rejects on first failure and **leaves the other two requests running** unless each branch has its own cancellation wiring. Their `.then` handlers can fire after your error handler already returned a 500, producing completion events that are no longer attached to the owning request.

`run.all` rejects on first failure and **cancels the other two**. `ctx.signal` aborts. `defer` cleanups run. The reason is typed: `CancelReason { kind: "sibling_failed", siblingId, error }`.

You can pivot a dashboard on that. You cannot pivot on `Error: AggregateError`.

> **Bench [`01-run-all-vs-promise-all.mjs`](../benchmarks/articles/01-run-all-vs-promise-all.mjs).** A succeeds at 50 ms. **B fails at 30 ms.** C succeeds at 100 ms.
>
> | Implementation | Outer rejected | A still ran past reject | C still ran past reject | Defer ran for losers |
> |---|---|---|---|---|
> | `Promise.all` | t=35 ms | **+16 ms** | **+79 ms** | n/a |
> | `run.all` | t=32 ms | **0 ms** (cancelled at +1 ms) | **0 ms** (cancelled at +1 ms) | yes before outer reject |

---

## `run.race` -- the race that actually races

```ts
const winner = await run.race([callOpenAI, callAnthropic, callGemini]);
```

Six tokens you wrote with `Promise.race`. Different runtime contract:

- Each body receives a `ctx.signal` linked to the race.
- First settlement cancels the rest at the `AbortSignal` boundary, **before TCP completes**.
- Each loser sees `CancelReason { kind: "race_lost", winnerId }` -- typed, exhaustively narrowed.
- `await run.race(...)` returns only after losers have finished cleaning up.

> **Bench [`02-run-race-vs-promise-race.mjs`](../benchmarks/articles/02-run-race-vs-promise-race.mjs).** Anthropic at 10 ms, OpenAI at 50 ms, Gemini at 80 ms.
>
> | Implementation | Winner at | OpenAI loser still ran | Gemini loser still ran | Loser reason |
> |---|---|---|---|---|
> | `Promise.race` | t=14 ms | **+47 ms** (61 ms total) | **+77 ms** (91 ms total) | none |
> | `run.race` | t=17 ms | **0 ms** (cancelled at t=16 ms) | **0 ms** (cancelled at t=16 ms) | `race_lost` |

That loser runtime x N parallel agents x P requests per second is the line on your invoice that nobody wrote.

---

## `run.any` -- first success, rest cancelled

```ts
const cheapest = await run.any([callExpensive, callCheap, callCheaper]);
```

`Promise.any` resolves with the first **success** and ignores the rest. The slower siblings keep running. The faster failing ones got logged and forgotten. `run.any` does the same -- except the slower siblings actually stop.

> **Bench [`03-run-any-vs-promise-any.mjs`](../benchmarks/articles/03-run-any-vs-promise-any.mjs).** A fails at 30 ms. B succeeds at 50 ms. C succeeds at 100 ms.
>
> | Implementation | Resolved at | C kept running | Defer ran for C |
> |---|---|---|---|
> | `Promise.any` | t=61 ms | **+47 ms** (108 ms total) | n/a |
> | `run.any` | t=65 ms | **0 ms** (cancelled at t=65 ms) | yes |

---

## `run.pool` -- bounded concurrency that cancels

```ts
const results = await run.pool(8, files.map((file) => async (ctx) => {
  return uploadOne(file, { signal: ctx.signal });
}));
```

`p-limit(8)` is a semaphore. That's useful, and current versions can clear pending queue items when you ask them to. What it is not is a structured scope: it does not automatically turn a sibling failure into in-flight cancellation, typed cancel reasons, cleanup, and a partial-result contract.

`run.pool(8, tasks)` is a semaphore + a scope. Default policy is `Promise.all`-style fail-fast: first throw cancels queued and in-flight. Results are positionally indexed regardless of completion order. Switch policy with one line and the **return type changes** so you can't ignore failures:

```ts
const out = await work(files).inParallel(8).onError("collect").do(uploadOne);

if (out.mode === "collect") {
  for (const r of out.results) {
    if (r.status === "rejected") logFailure(r.reason);
  }
}
```

`WorkOutput<R>` is a discriminated union -- `mode: "fail" | "continue" | "collect"`. Change `.onError("continue")` and the return type forces you to handle `errors[]`. The compiler is your audit log.

> **Bench [`04-pool-vs-semaphore.mjs`](../benchmarks/articles/04-pool-vs-semaphore.mjs).** 10 items, concurrency 4. Item 3 throws at 20 ms; the rest take 100 ms each.
>
> | Implementation | Outer rejected | Started | Fulfilled AFTER rejection | Cancelled | Never started | Longest post-rejection run |
> |---|---|---|---|---|---|---|
> | local `pLimitLike(4)` semaphore baseline | t=31 ms | 10 | **9** | 0 | 0 | **+295 ms** |
> | `run.pool(4, ...)` | t=33 ms | 4 | 0 | 3 | 6 | **0 ms** |

295 ms of post-rejection work, multiplied across a fleet, becomes avoidable runtime and provider cost.

---

## `run.retry` -- composable, cancel-aware backoff

```ts
const callWithRetry = run.retry(callProvider, {
  times: 4,
  backoff: "exponential",
  initialDelay: "200ms",
  maxDelay: "5s",
  jitter: true,
  retryIf: (err) => isTransient(err),
});

const answer = await callWithRetry(ctx);
```

Three things WorkIt makes part of the retry contract:

1. **Stop retrying on scope cancellation.** When the parent scope cancels mid-attempt, `run.retry` does not enqueue another attempt. The task settles as `cancelled`, not `failed`.
2. **Validate input at the boundary.** `run.retry({ times: 1e9 })` would create an unbounded retry policy. `run.retry` rejects it: `RangeError: retry attempts must be an integer between 1 and 1000`. Bound is `MAX_RETRY_ATTEMPTS`.
3. **Sleep with the scope signal.** Backoff sleep is interruptible -- abort the signal, the sleep rejects, the loop exits. The benchmark below compares against a signal-unaware retry loop; current retry libraries may expose their own abort hooks, but they still do not own WorkIt's scope tree, cleanup, and cancel-reason contract.

> **Bench [`05-retry-on-cancel.mjs`](../benchmarks/articles/05-retry-on-cancel.mjs).** Body throws on every attempt. External cancel fires around t=50 ms. Up to 8 retries with 50 ms backoff.
>
> | Implementation | Cancel observed | Outer settled | Cancel latency | Extra attempts after cancel | Settled as |
> |---|---|---|---|---|---|
> | signal-unaware retry loop | t=63 ms | t=701 ms | **638 ms** | **7** | `rejected` |
> | `run.retry` | t=61 ms | t=61 ms | **0 ms** | **0** | `cancelled` (kind: `manual`) |

638 ms of wasted retry work after the user already cancelled. Per request. Multiply by the agent fan-out.

---

## `run.timeout` -- composes with retry, race, and pool

```ts
const fastest = await run.race([
  run.timeout(callPrimary,   "800ms"),
  run.timeout(callSecondary, "800ms"),
]);
```

`run.timeout(task, "800ms")` returns a `TaskFn`. It composes. You can wrap it in `run.retry`. You can put it inside `run.race`. You can hand it to `run.pool`. The signature is closed under composition.

Promise timeout helpers return promises or decorated promises. Some expose `AbortSignal` support. They still do not return a WorkIt `TaskFn`, so crossing timeout, retry, race, pool, and cleanup means you own the composition boundary.

---

## `run.fallback` -- primary, secondary, type-safe

```ts
const callWithFallback = run.fallback(
  run.retry(callProvider, 3),
  callBackupProvider,
);
```

Primary fails (after retries) -> secondary runs. Same `ctx.signal`. Same scope. Same cancel reason if the parent stops. No nested `try/catch`. No "did I forget to await the fallback" Slack message at 2 a.m.

---

## `run.supervise` -- restart policy for long-lived work

`run.retry` is for one operation that may fail transiently and then succeed. `run.supervise` is for a **long-lived task** -- a heartbeat, a queue consumer, a connection watcher, an agent keep-alive -- that may need restart semantics with bounded backoff.

```ts
import { run } from "@workit/core";

const result = await run.supervise(async () => {
  attempts++;
  if (attempts < 3) throw new Error("transient worker failure");
  return "stable";
}, {
  restartOn:    "error",
  maxRestarts:  3,
  backoff:      () => 1,
});
```

```ts
// samples/supervision.sample.js -- asserted in CI:
//   result === "stable"
//   attempts === 3
```

The supervised body fails twice, restarts each time under the policy, and stabilises on the third attempt. The parent scope can still cancel everything at once, and the cancel reason carries down through the supervision wrapper. Restart policies cap at `maxRestarts` per `resetWindow` so a permanently broken body doesn't infinite-loop.

```sh
npm run sample:supervise
```

The decision rule: use `run.retry` for a single call that can hiccup; use `run.supervise` for a process that should keep running.

---

## `run.hedge` -- bounded speculative requests

```ts
const ranked = await run.hedge(
  (ctx) => reranker.rank(question, sources, { signal: ctx.signal }),
  { after: "2s", max: 2 },
);
```

If the first call hasn't returned in 2 seconds, fire a second one. First success wins; the rest cancel. Bounded by `max`, this is a measured way to reduce tail latency without paying for every speculative fan-out.

> **Bench [`06-hedge-tied-requests.mjs`](../benchmarks/articles/06-hedge-tied-requests.mjs).** Two scenarios, opts `{ after: "50ms", max: 3 }`.
>
> | Scenario | Body latency | Attempts fired (timestamps) | Winner | Losers cancelled | Cancel reason |
> |---|---|---|---|---|---|
> | slow | 200 ms | 3 (t=2 ms, 62 ms, 107 ms) | id=1 at 217 ms | 2 | `race_lost` |
> | fast | 30 ms | **1** (no hedge fired) | id=1 at 31 ms | 0 | n/a |

The fast path doesn't pay for hedging at all. The slow path bounded by `max`. Every loser tagged with `race_lost`.

---

## Side-by-side -- who actually cancels

```ts
// 3 tasks. B fails at 30 ms. A succeeds at 50 ms. C succeeds at 100 ms.

await Promise.all([A, B, C]);     // rejects at 30 ms. A and C keep running for ~16/63 ms.
await Promise.race([A, B, C]);    // rejects at 30 ms. A and C keep running.
await Promise.any([A, B, C]);     // resolves at 50 ms. C keeps running for ~44 ms.

await run.all([A, B, C]);         // rejects at 30 ms. A and C cancelled in 1 ms, defer ran.
await run.race([A, B, C]);        // rejects at 30 ms. A and C cancelled in 0-1 ms.
await run.any([A, B, C]);         // resolves at 50 ms. C cancelled in 0 ms, defer ran.
```

Same shape. Different contract. Native primitives return a value. WorkIt primitives own the tree underneath the value.

---

## How do other libraries compare

| Tool | Cancels on sibling failure | Signal-aware retry | Composable timeout (returns `TaskFn`) | Hedged requests | Bundle |
|---|---|---|---|---|---|
| **WorkIt** | yes | yes | yes | yes built-in | **14,175 B / 4,835 B gz** for all nine composables |
| `Promise.all` / `race` / `any` | no | n/a | n/a | n/a | 0 |
| `p-limit` + `p-retry` + `p-timeout` | partial/manual wiring | partial/manual wiring | separate abstractions | no | three deps |
| `RxJS` | yes on `unsubscribe` | partial via operators | yes via operators | no | large |
| Effection | yes structured (generator ops) | yes | yes | no | medium |
| Effect-TS | yes structured (fibers + typed `Cause`) | yes | yes | no | large |

For simple array processing where nothing else can fail, `p-limit` is fine. For full-stack apps where you want a broader effect or operation model, Effection and Effect-TS are solid. WorkIt's distinction is narrower: structured-concurrency composition without leaving `async`/`await`, with nine composables in one ownership tree and the bundle size shown above.

---

## Receipts

The WorkIt runtime claims above are verified by either `npm run verify` (the production gate) or `npm run bench:articles` (the side-by-side suite that produced the representative timing tables in this article).

```sh
npm run bench:articles
# full article suite: 19 passed, 0 failed
```

This article cites benches 01-06 from the full suite. Each bench script is **~100 lines, zero external dependencies**, and asserts the WorkIt invariant in-line. Timings are representative captured runs; the assertions guard semantic invariants, not exact milliseconds. The folder has its own `package.json` so the published package's dependency graph stays empty. Read the README at [`benchmarks/articles/`](../benchmarks/articles/README.md) for how the promise-helper baselines stay honest.

Production-side gates that back the same composables:

| Claim | Evidence |
|---|---|
| Cancellation safety, all composables | Benches 01-06 plus [`tests/evidence/lifecycle/owned-work.mjs`](../tests/evidence/lifecycle/owned-work.mjs) verify parent cancellation, sibling failure, retry cancellation, race loser cleanup, and owned background work. |
| `run.retry` validation | `RangeError` for `times` <= 0, > 1000, NaN, Infinity, fractional. Identical rejection on numeric and object form. |
| `run.race` / `run.any` loser cleanup | LIFO `defer` blocks observed in test for every loser; outer promise does not resolve until cleanup completes |
| Bundle of all nine composables | Included in 14,175 B min / 4,835 B gzip core-group-import. Tree-shaken if unused. |

---

## What's next

Nine composables share one engine. Tomorrow we open the engine.

We'll look at what cooperative cancellation can do, what it cannot do, and where the hard boundary starts. Then we put a CPU spin loop that ignores every signal in front of `offload({ timeout: "200ms" })` and verify that worker termination prevents a late marker file from appearing. The CI gate runs `stat()` on it.

AbortController cannot preempt a CPU loop. WorkIt cannot change that language boundary, but a worker thread can be terminated by its host.

---

## Source, Benchmarks, And Evidence

- Source: https://github.com/WorkRuntime/workit
- Article source: https://github.com/WorkRuntime/workit/blob/main/articles/02-concurrency-retry-timeout.md
- Reproduce: `npm run bench:articles` and `npm run test:evidence`
