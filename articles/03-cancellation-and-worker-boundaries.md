<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Cancellation, Cooperation, And Worker Boundaries

*Last time we showed nine composables that cancel siblings, retry with signal-aware backoff, and hedge tied requests. That's cooperative cancellation -- it works when the body checks the signal and the I/O it makes is signal-aware. This article answers the hard question: what happens when code does not cooperate?*

Drop this in a worker module:

```js
// benchmarks/articles/lib/spinner.mjs -- ignores every signal you throw at it
import { writeFileSync } from "node:fs";

export function spin({ durationMs, markerPath }) {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    Math.sqrt(Math.random() * 1e6);
  }
  writeFileSync(markerPath, "late-marker-written-by-worker");
  return { completed: true, elapsedMs: Date.now() - start };
}
```

This is the canonical "non-cooperative" body. Tight loop, no `await`, no `signal.aborted` check. In a single-threaded JS runtime, cooperative cancellation cannot stop it from the outside. `AbortController` can record cancellation, but the callback cannot run until the event loop yields.

```ts
import { offload } from "@workit/core/worker";
import { run } from "@workit/core";

await run.scope(async (scope) => scope.spawn(
  offload(spinnerURL, "spin", { durationMs: 5_000, markerPath }, { timeout: "200ms" }),
));
```

200 ms later: `TimeoutError`. The worker thread is terminated by the host. The late-marker file **does not exist** on disk. We `stat()` for it in CI and fail the gate if it does.

That's the only honest answer to "can JS forcibly stop work". The answer is *no on the main thread* -- but you can move the work to a worker and have the host kill the thread.

WorkIt has both layers. They are labeled honestly.

> **Bench [`07-worker-hard-kill.mjs`](../benchmarks/articles/07-worker-hard-kill.mjs).** 5,000 ms spin loop. 200 ms timeout. Late-marker file written *after* the loop completes. Timings are representative; the invariant is the marker-file result.
>
> | Implementation | Settled at | Late-marker file on disk |
> |---|---|---|
> | Main-thread `AbortController.abort()` | t=5,001 ms (full duration) | **yes exists** -- the abort callback never even fired; the event loop was starved |
> | `offload({ timeout: "200ms" })` | t=206 ms with `TimeoutError` | **no does not exist** -- and stays absent through an 800 ms grace window |

The native baseline is the receipt for "AbortController cannot preempt a CPU loop." The body completed all 5 seconds and wrote the marker, and the `setTimeout` that was supposed to fire `controller.abort()` at 200 ms could not be delivered because the event loop never returned. The abort callback never ran.

---

## Layer 1 -- Cooperative cancellation, in-process

```ts
async function callTool(input, ctx) {
  ctx.signal.throwIfAborted();                              // explicit checkpoint
  const res = await fetch(url, { signal: ctx.signal });     // signal-aware
  ctx.signal.throwIfAborted();                              // checkpoint after I/O
  return res.json();
}
```

Cooperative cancellation works when the body checks the signal at safe points and the I/O it makes is signal-aware. WorkIt handles the checkpoints automatically through `await` boundaries inside `run.retry`, `run.timeout`, `run.race`, and the `work()` builder. You just have to thread `ctx.signal` into the I/O calls.

This works for 95% of code: HTTP, database, filesystem, streams, child processes, sleeps, channel sends. They all take an `AbortSignal`.

It does not work for the 5% that does CPU loops, sync `crypto`, sync `JSON.parse` of a 200 MB string, or a fitness test in a genetic algorithm.

For that 5%, you need Layer 2.

---

## Layer 2 -- Hard kill at the worker boundary

```ts
import { offload } from "@workit/core/worker";

const transcoded = offload(
  new URL("./ffmpeg-transcode.js", import.meta.url),
  "transcode",
  { input, format: "webm" },
  { timeout: "30s" },
);

await run.scope(async (scope) => scope.spawn(transcoded));
```

`offload(...)` returns a `TaskFn`. Spawn it into a scope. The named export runs in a Worker thread. When the timeout fires the worker is **terminated** -- not signalled, not asked nicely. The host process keeps running. The promise rejects with `TimeoutError`. If the parent scope cancels first, the worker is terminated with a `CancellationError` carrying the parent's reason.

What `offload` accepts:

- Local file URLs (`new URL("./mod.js", import.meta.url)`).
- Named export only.
- Structured-cloneable input: primitives, arrays, plain objects, `Map`, `Set`, `Date`, `RegExp`, `ArrayBuffer`, `SharedArrayBuffer`, typed array views.

What `offload` rejects, before the worker spins up:

- Remote and inline URL schemes (`https:`, `data:`, `blob:`).
- Path traversal segments.
- Functions, symbols, class instances, custom-prototype objects -- including buried inside `Map` values, `Set` members, or cycles.

The worker boundary is covered by unit tests and by [`tests/evidence/security/worker-boundary.mjs`](../tests/evidence/security/worker-boundary.mjs). The two interesting subtleties: `Object.create(null)` is accepted (a null-prototype object is "plain enough"), and a class with a clean-looking shape is rejected at deep walk because the prototype check runs on the cloneable graph, not just the top level.

### Worker offload -- the happy path

The hard-kill is the headline, but the everyday use of `offload` is mundane CPU work. The repo ships a sample that runs two Fibonacci computations on real worker threads through `run.pool`:

```ts
// samples/worker-offload.sample.js
const moduleURL = new URL("./cpu-worker.sample-worker.js", import.meta.url);

const results = await run.pool(2, [
  offload(moduleURL, "fibonacci", 20),
  offload(moduleURL, "fibonacci", 21),
]);

// Asserted by the sample:
//   results.map(r => r.value) === [6_765, 10_946]
//   results.every(r => r.threadId > 0)
```

Different OS thread per task. Both results returned. No `try/catch` around `Worker`. No `parentPort` plumbing. Just `offload(modURL, "fnName", input)` composed through the same `run.pool` you saw in article 02. The same primitive that terminates a CPU spinner at the worker boundary is also the one you use to take a heavy sync transform off the event loop.

```sh
npm run sample:worker
```

---

## The shield: `run.uncancellable`

Some code must run to completion even when the parent scope is being cancelled. Database commit. Stripe webhook receipt. Distributed lock release. Audit log flush.

```ts
import { run } from "@workit/core";

const commit = run.uncancellable(async (ctx) => {
  await db.commit({ signal: ctx.signal });
  await flushReceipt({ signal: ctx.signal });
}, { timeout: "2s" });

await run.scope(async (scope) => scope.spawn(commit));
```

Inside the shielded body, `ctx.signal` is a fresh signal local to the shield -- the parent's cancel does not propagate in. The shield has its own bounded lifetime (`timeout: "2s"`). When the shield finishes, if the parent had cancelled during the shield, the original `CancellationError` rethrows after the body completes. **Cancellation is delayed, not hidden.**

What this is not: `run.uncancellable` is **cooperative**. It cannot stop a non-cooperative CPU loop inside the shielded body. For that, use `offload`.

> **Bench [`08-uncancellable-shield.mjs`](../benchmarks/articles/08-uncancellable-shield.mjs).** Three scenarios -- measured.
>
> | Scenario | What we measure | Result |
> |---|---|---|
> | A. Parent cancel mid-body | Body started t=1 ms, parent cancelled at t=41 ms, body sleeping 120 ms | Body completed naturally at t=136 ms (**outlived cancel by 95 ms**), `bodyObservedAbort: false`, outer settled `cancelled` with `reason.kind === "manual"` |
> | B. Shield timeout while body runs | Shield `{ timeout: "100ms" }`, body sleeping 2,000 ms | Body **observed abort** at ~100 ms, `bodyAbortReasonClass === "TimeoutError"`, outer settled `TimeoutError` |
> | C. Nested shields, outer scope cancels | Inner sleep 80 ms, outer scope cancels at t=20 ms | Inner completed at t=92 ms, outer-shield body completed at t=92 ms, outer settled `cancelled` at t=93 ms with `reason.kind === "manual"` -- preserved through both shields |

A is the "delayed cancel" contract. B is "the shield is bounded by its own timeout, which the body sees as a `TimeoutError` on its local signal". C is "nested shields don't lose the outer cancel reason."

---

## Cancellation reasons are typed, not strings

```ts
type CancelReason =
  | { kind: "user"; message: string }
  | { kind: "deadline"; deadlineAt: number; elapsedMs: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "parent_failed"; error: unknown }
  | { kind: "sibling_failed"; siblingId: TaskId; error: unknown }
  | { kind: "race_lost"; winnerId: TaskId }
  | { kind: "budget"; budgetKey: string; limit: number; spent: number }
  | { kind: "scope_ended" }
  | { kind: "manual"; tag: string; data: unknown };
```

Every cancellation in WorkIt carries one of these. You can pivot a metric on `cancelReason.kind`. You can route a runbook on `tag`. You can build a "why did my agent stop" dashboard with seven buckets and an exhaustive `switch`. TypeScript will tell you when you forgot a case.

Compare:

```ts
controller.abort("user_clicked_stop");                  // string. lossy. arbitrary.
controller.abort(new DOMException("...", "AbortError")); // class with "Abort" name. that's it.
```

`AbortSignal.reason` was a stringly-typed escape hatch that won. WorkIt closes it with a discriminated union and tests that every `kind` is exercised in the suite.

---

## How do other libraries handle non-cooperative work

| Library | Cooperative cancellation | Hard kill (CPU loops) | Mechanism |
|---|---|---|---|
| **WorkIt** | yes signal-aware | yes built-in | `offload({ timeout })` terminates the worker thread |
| Effection | yes generator ops | no | bring your own worker |
| Effect-TS | yes fibers | no | bring your own worker |
| Native `AbortController` | yes | no | the event loop is single-threaded |

If you need to kill a sync CPU loop today and you're not on WorkIt, you're hand-rolling worker management -- module URL validation, structured-clone classification, timeout-driven termination, parent-cancel propagation, error propagation back to the host. WorkIt's `offload` is ~50 lines of public surface and the runtime contract is in CI.

---

## Receipts

Two layers. Two benches. One evidence path per claim.

```sh
node benchmarks/articles/07-worker-hard-kill.mjs       # main-thread vs offload
node benchmarks/articles/08-uncancellable-shield.mjs   # 3 shield contracts
node benchmarks/articles/run-all.mjs                   # full article suite
```

Production-side gates that back the same contracts:

| Claim | Evidence |
|---|---|
| Worker hard-kill on CPU spinner | [`07-worker-hard-kill.mjs`](../benchmarks/articles/07-worker-hard-kill.mjs) runs `offload({ timeout: "200ms" })` against the spinner module, asserts bounded rejection, and verifies the late-marker file does not exist. |
| Worker hard-kill on parent cancel | [`tests/evidence/security/worker-boundary.mjs`](../tests/evidence/security/worker-boundary.mjs) verifies parent cancellation terminates worker-owned CPU work. |
| 5 concurrent offloads | Worker unit coverage exercises mixed fast and spinning workers without cross-talk between results. |
| Input validation | [`tests/evidence/security/worker-boundary.mjs`](../tests/evidence/security/worker-boundary.mjs) verifies remote and executable worker URLs are rejected; unit coverage exercises structured-clone classification. |
| `run.uncancellable` semantics | [`08-uncancellable-shield.mjs`](../benchmarks/articles/08-uncancellable-shield.mjs) covers parent cancel during body, shield timeout, nested shields, signal isolation, and reason preservation. |
| `CancelReason.kind` coverage | Every kind in the discriminated union has at least one tracked test that produces it. |

The ergonomic version of cooperative cancellation:

```ts
await sleep(ms, ctx.signal);             // signal-aware sleep
await fetch(url, { signal: ctx.signal }); // signal-aware fetch
```

The ergonomic version of hard cancellation:

```ts
await scope.spawn(offload(modUrl, "fn", input, { timeout: "Xs" }));
```

That's the API. Two layers. Honest labels.

---

## What's coming

Tomorrow: backpressure.

You're consuming a billion-row source you'll never materialize. You want to read 25 from the front, run them through a 16-wide map, and have the producer pause when the consumer can't keep up. You want a transcription stream that exits cleanly when the user closes the tab. You want CSP-style channels for the part of your pipeline that's actually a pipeline.

The slow-consumer memory gate runs **a million items** through a paused consumer in CI and asserts the heap doesn't move. That's the next bench.

---

## Source, Benchmarks, And Evidence

- Source: https://github.com/WorkRuntime/workit
- Article source: https://github.com/WorkRuntime/workit/blob/main/articles/03-cancellation-and-worker-boundaries.md
- Reproduce: `npm run bench:articles` and `npm run test:evidence`
