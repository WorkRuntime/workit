<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Owned Async Work In TypeScript

Three providers. One winner. Three invoices.

```ts
const winner = await Promise.race([
  fetch(OPENAI,    { body }),
  fetch(ANTHROPIC, { body }),
  fetch(GEMINI,    { body }),
]);
```

It is easy to assume a race cancels the losers. Native `Promise.race` resolves on the first settlement and leaves every other promise running unless the caller wires cancellation into each branch. TCP completes. Tokens bill. `.then` callbacks fire. Cleanup remains a manual convention. `Promise.any` and `Promise.all` have the same ownership gap.

Native promises model values, not ownership. There is no ownership parent, no built-in cancellation path, and no scope cleanup contract.

There is still work running after the value settles.

---

## The one line that fixes the 80% case

Before we fix racing, fix the thing every codebase does first: process a list of items with concurrency, retries, and a timeout.

```ts
import { work } from "@workit/core";

await work(items)
  .inParallel(8)
  .withRetry(3)
  .withTimeout("5s")
  .do(async (item, ctx) => {
    ctx.report({ message: `processing ${item.id}` });
    return apiCall(item, { signal: ctx.signal });
  });
```

That isn't a custom Promise chain. It isn't a standalone concurrency helper where cancellation, retry, timeout, and cleanup have to be wired separately. It's a runtime contract:

- At most **8 inflight** at any instant. The cap is a hard property test, not a hint.
- Each item retries up to **3 times**, exponential backoff with jitter, signal-aware sleep.
- Any item exceeding **5 seconds** cancels its own operation with `TimeoutError`.
- First uncaught failure cancels the queued and the in-flight, by default. Switch policy on a single line and the **return type changes** so you can't ignore failures:

```ts
const out = await work(items).inParallel(8).onError("collect").do(fn);
//    ^^^ WorkOutput<R> -- discriminated union: "fail" | "continue" | "collect"
if (out.mode === "collect") {
  for (const r of out.results) if (r.status === "rejected") log(r.reason);
}
```

- Every body receives a `ctx.signal` linked to the scope, so the `fetch`, the database query, or the LLM call **actually aborts** at the I/O boundary.
- Progress events flow to your logger, metrics, or UI through `ctx.report(...)` -- zero allocation when nobody listens.

That is the surface. Five chained methods. No new vocabulary. Now stack it.

---

## `run.race`: same shape, different contract

```ts
import { run } from "@workit/core";

const winner = await run.race([callOpenAI, callAnthropic, callGemini]);
```

Same six tokens you wrote with `Promise.race`. Different runtime contract:

- Each body receives a `ctx.signal` linked to the race.
- First settlement cancels the rest at the `AbortSignal` boundary, **before** TCP completes.
- Each loser sees `CancelReason { kind: "race_lost", winnerId }` -- typed, exhaustively narrowed, not a string.
- Each loser's `ctx.defer(...)` cleanup runs LIFO before `run.race` resolves.
- `await run.race(...)` returns only after losers have finished cleaning up.

That is the first ownership boundary. Now stack it again.

---

### Cancel a 200-tool agent on client disconnect

```ts
import { run } from "@workit/core";

await run.scope(async (scope) => {
  request.signal.addEventListener("abort", () =>
    scope.cancel({ kind: "manual", tag: "client_disconnect" }));

  for (const step of plan.steps) {
    scope.spawn(async (ctx) => callTool(step, ctx.signal),
      { name: step.name, kind: "tool" });
  }
  scope.spawn.background(async () => auditLog(plan));
}, { deadline: "30s" });
```

Every in-flight tool aborts. Every `ctx.defer` runs LIFO. The audit task flushes. The reason -- `{ kind: "manual", tag: "client_disconnect" }` -- carries down the tree so your dashboard distinguishes a stop from a `deadline` from a `budget` overrun.

### A socket close cancels an STT stream and closes the microphone

```ts
import { transcribeStream } from "@workit/core/ai";

for await (const text of transcribeStream(microphone, {
  async transcribe(chunk, ctx) {
    return provider.transcribe(chunk, { signal: ctx.signal });
  },
}, { signal: socket.signal })) {
  socket.send(text);
}
```

Socket disconnects. `ctx.signal` aborts. The provider's HTTP request aborts. The async generator's `finally` runs and closes the microphone. The sample asserts that the source closes and no provider call remains active after disconnect.

### 100,000 documents under a hard token cap

```ts
import { group, run } from "@workit/core";
import { OpenAITokens, embedAll } from "@workit/core/ai";

await run.context.with(
  OpenAITokens, { spent: 0, limit: 1_000_000, unit: "tokens" },
  () => group(() => embedAll(documents, { concurrency: 32 })),
);
```

Bounded concurrency. Per-item retry. Token budget enforced atomically across all 32 inflight workers. Blow the cap mid-pipeline and the scope cancels with `CancelReason { kind: "budget", limit, spent }`. Partial results stay. The rest abort.

---

## No Orphans Means No Unowned Background Work

A `background` child is still scoped. The parent operation does **not** finish while owned background work keeps running. The receipt is one of the smallest samples in the repo:

```ts
// samples/no-orphan.sample.js
const result = await group(async (task) => {
  task.background(async (ctx) => {
    await sleep(20, ctx.signal);
    backgroundCompleted = true;
  });
  return "body-returned";
});

// Asserted by the sample:
//   result === "body-returned"
//   backgroundCompleted === true
//   elapsedMs >= 15
```

The body returns its value at t=0. The owned background task takes 20 ms. The `await group(...)` does **not** resolve until both finish. If you want to escape the scope, you call `run.detached(...)` and accept the orphan trade-off explicitly. There is no third option.

```sh
npm run sample:no-orphan
```

---

## Why not just use X

The right tool depends on what part of the lifecycle you actually own.

| Tool | Bounded concurrency | Scope-owned loser / sibling cancellation | Typed cancel reason | Scope cleanup |
|---|---|---|---|---|
| **WorkIt** | yes `work().inParallel(N)` / `run.pool(N, ...)` | yes at the `AbortSignal` boundary | yes `CancelReason` discriminated union | yes `ctx.defer` LIFO |
| `Promise.all` / `race` / `any` | no | no | no | no |
| `p-limit` | yes | manual; queue ownership is separate from task cancellation | no | no |
| `p-map` | yes | partial/manual; queue and in-flight work have separate policies | no | no |
| `RxJS.mergeMap` | yes | yes on unsubscribe | partial | per-subscription, not per-scope |
| Effection | yes via generator ops | yes (structured) | partial | yes |
| Effect-TS | yes via fibers | yes | yes (typed `Cause`) | yes |

If your problem is "process this array with N concurrency" and nothing else ever fails, `p-limit` is fine. If your problem is "this list is part of a request that can time out, the user can disconnect, and one bad item must cancel the rest with cleanup", you want a runtime contract. Effection and Effect-TS provide one -- through generators and a fiber DSL respectively. WorkIt provides one **without leaving `async` / `await`**.

---

## Receipts

The release-readiness claim above is a CI gate, not a tagline. Each row maps to a command in `npm run verify`.

| Measurement | Value | What it includes |
|---|---|---|
| `core-group-import` bundle | **14,175 B min * 4,835 B gzip** | The full `group` + `run` + `work` + retry/timeout/race/all/any/pool surface, tree-shaken |
| Runtime dependencies | **0** | Zero. The compiled core does not import `node:http`, `node:https`, or `fetch`. Static check enforced. |
| Tests / coverage | **214 tests * 100% statements / branches / functions / lines** | Cancellation invariants, channel semantics, AI-subpath mocks, exporter stress, scope tree, budget atomicity |
| Hot-path heap, 100k tasks, no signal read | **0.9 MB post-GC** | Was 298 MB before lazy `AbortController` allocation -- ~330x reduction |
| Tracked soak gate, 100k tasks @ concurrency 128 | **126,136 B** max heap growth | The `npm run check:soak` gate fails the build if this regresses |
| Stream backpressure, 1,000,000 logical items, slow consumer | **maxActive <= inParallel(N)**, producer paused, heap bounded | The `npm run check:stream-memory` gate |
| `offload({ timeout: "200ms" })` against an infinite CPU spin loop | rejects at the worker timeout boundary, **late-marker file does not exist** | AbortController cannot preempt a CPU loop; the worker is terminated at the host boundary. CI `stat()`s for the marker. |
| Claim evidence suite | `npm run test:evidence` | Curated lifecycle, correctness, security, release, and performance proofs mapped in `evidence/claims.json` |

---

## The series

1. **You are here** -- *Promise.race does not own the losing work. The fluent surface and why ownership matters.*
2. *Nine composables. One ownership contract.*
3. *AbortController cannot preempt a CPU loop. WorkIt uses a worker boundary.*
4. *A 1,000,000,000-row pipeline. 25 consumed. The producer noticed.*
5. *A 0.50 USD agent. A connection that closes on ctrl-C. A receipt the user never sees.*
6. *100K agent runs a day. Bounded observability cost without core bloat.*
7. *An agent loop in 12 lines. A typed tool contract. A 50-cent ceiling.*


---

## Try it

```sh
npm install @workit/core
```

The API is stable. The tests pass. The bundle is tiny.

*Next: `run.all`, `run.race`, `run.any`, `run.pool`, `run.series` side-by-side with `Promise.all`, `Promise.race`, `Promise.any`, `p-limit`, and `p-map`. We measure which contracts still hold when one sibling throws mid-flight.*

---

## Source, Benchmarks, And Evidence

- Source: https://github.com/WorkRuntime/workit
- Article source: https://github.com/WorkRuntime/workit/blob/main/articles/01-owned-async-work.md
- Reproduce: `npm run bench:articles` and `npm run test:evidence`
