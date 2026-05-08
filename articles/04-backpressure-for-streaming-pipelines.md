<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Backpressure For Streaming Pipelines

*Last time we showed how to terminate non-cooperative CPU work at the worker boundary. This article stays cooperative but adds the missing piece: backpressure, the runtime contract that lets a producer pause the moment the consumer can't keep up.*

A RAG ingest pipeline has a billion candidate documents. You only need the 25 that match a downstream filter. A naive promise collection can materialize far more work than the consumer needs; a hand-rolled async iterator can still fill a prefetch buffer before the first result arrives. With WorkIt:

```ts
import { work } from "@workit/core";

async function* billionDocuments() {
  for (let i = 0; i < 1_000_000_000; i++) yield { id: i, text: `doc ${i}` };
}

const results = [];
for await (const processed of work(billionDocuments())
  .inParallel(16)
  .map(async (doc, ctx) => enrich(doc, { signal: ctx.signal }))
  .stream()) {
  results.push(processed);
  if (results.length === 25) break;
}
```

Two things to notice:

- **`work()` accepts an async iterable directly.** No `.from()`, no `Readable.from(...)` shim. The signature is `Iterable<I> | AsyncIterable<I> -> WorkBuilder<I, I>`.
- **`.map().stream()` is the streaming pipeline form.** `.do(fn)` returns a `Promise<WorkOutput<R>>` (full batch result). `.map(fn)` returns a new builder; `.stream()` on a builder returns an `AsyncIterable<O>` that respects backpressure. Both terminals exist; you pick by what the consumer is doing.

What the producer actually does:

> **Bench [`09-stream-1b-lazy.mjs`](../benchmarks/articles/09-stream-1b-lazy.mjs).** 1,000,000,000-row generator. `inParallel(16)`. Consumer takes 25, breaks.
>
> | Implementation | Consumed | **Items pulled from the generator** | maxActive | In-flight after break |
> |---|---|---|---|---|
> | Naïve eager prefetch buffer (256-deep) | 25 | **281** | 1 | 0 (all let to settle) |
> | `work().inParallel(16).map().stream()` | 25 | **40** | 1 | 0 (cancelled at break) |

These are representative captured values. The bench `assert`s the invariant: produced items stay bounded by `TAKE + CONCURRENCY`. The naïve baseline pulled 281 items because once the prefetch buffer is full it doesn't pause the producer -- it pauses the worker pool, which is a different question.

That's **backpressure**: the producer pauses when the consumer slows down or stops, not when the worker pool fills.

---

## `work().stream()` -- bounded, lazy, cancellable

```ts
for await (const summary of work(documents)
  .inParallel(8)
  .withRetry(2)
  .withTimeout("15s")
  .map(async (doc, ctx) => summarize(doc, { signal: ctx.signal }))
  .stream()) {
  ui.append(summary);
}
```

Properties the runtime guarantees:

- **`inParallel(N)` is a hard cap.** `maxActive` never exceeds `N`. Property test runs 1..20 wide x 1..100 items, asserts the cap holds across every shape.
- **`stream()` is lazy.** The producer iterator pulls only when an inflight slot is free.
- **`break` is cancellation.** The remaining inflight tasks abort with `CancelReason { kind: "manual", tag: "stream_consumer_closed" }`. Their `ctx.defer` runs. The producer iterator's `return()` runs.
- **A throw inside the body** triggers `CancelReason { kind: "manual", tag: "stream_failed" }` for siblings -- typed, distinguishable from the consumer-break path on a dashboard.
- **Slow consumer pauses producer.** Tracked under `check:stream-memory`: 1,000,000 logical items, slow consumer, bounded heap growth, and no unbounded producer advance.

> **Bench [`10-stream-slow-consumer.mjs`](../benchmarks/articles/10-stream-slow-consumer.mjs).** 5,000-item source, `inParallel(16)`, consumer ~5 ms per item, take 200.
>
> | Metric | Value |
> |---|---|
> | Consumed | 200 |
> | Produced | **215** |
> | Producer overshoot | **15** (bound: `CONCURRENCY + 1` = 17) |
> | maxActive | 1 |
> | In-flight after break | 0 |
> | Wall time | ~3,108 ms |

The interesting detail: even with `inParallel(16)`, `maxActive` stayed at 1 because the consumer was the bottleneck. The runtime didn't speculatively saturate the worker pool -- it paced the producer to consumer demand. That is what "backpressure" actually means. A pool that always runs at capacity isn't backpressure; it's a pool.

### Streaming map: stop after 12, produce only what demand requires

The most practical reader-facing form of the same property -- a real summarizer pipeline, the size of a real prompt:

```ts
// samples/streaming-summarizer.sample.js
const TAKE = 12;
const CONCURRENCY = 5;

for await (const summary of work(documents())
  .inParallel(CONCURRENCY)
  .withRetry(2)
  .withTimeout("500ms")
  .map(async (doc, ctx) => `summary:${doc.id}`)
  .stream()) {
  summaries.push(summary);
  if (summaries.length === TAKE) break;
}

// Asserted by the sample:
//   summaries.length === TAKE
//   produced     <= TAKE + CONCURRENCY - 1
//   maxActive    === CONCURRENCY
//   active       === 0       // all in-flight cancelled cleanly on break
```

50-doc generator. Consume 12. Producer never advances past 16. Concurrency cap exact. Active count zero after `break`. Retry and timeout policy attached without breaking the pull cadence.

```sh
npm run sample:stream
```

---

## Defaults that don't surprise

| Setting | Default | Why |
|---|---|---|
| `inParallel` | `1` (sequential) | Auto-concurrency surprises rate-limited APIs. Sequential is correct. |
| `withRetry` | none | Retrying non-idempotent ops silently is a footgun. |
| `withTimeout` | none | Cancelling work the user didn't ask to cancel is worse than no timeout. |
| `onError` | `"fail"` | Matches `Promise.all` intuition. The discriminated `WorkOutput<R>` return type forces explicit handling on the others. |

You opt **into** resilience. Nothing is implicit.

---

## CSP-style channels -- `@workit/core/channel`

`work().stream()` is the right shape when the producer-consumer relationship is one fluent pipeline. When the producer and consumer are independent tasks running side by side -- fan-in, fan-out, work-queue -- you want a channel.

```ts
import { createChannel } from "@workit/core/channel";
import { group } from "@workit/core";

const orders = createChannel<Order>({ capacity: 100 });

await group(async (task) => {
  task(async (ctx) => {
    for await (const o of orderSource()) {
      await orders.send(o, { signal: ctx.signal });
    }
    orders.close();
  });

  task(async (ctx) => {
    for await (const o of orders) {
      await processOrder(o, { signal: ctx.signal });
    }
  });
});
```

Channel contract, all five rows verified by [`11-channel-contract.mjs`](../benchmarks/articles/11-channel-contract.mjs):

| # | Scenario | Bench observation |
|---|---|---|
| A | `send` blocks when the channel is full | On a `capacity: 2` channel, the third `send` is still pending after a microtask turn and completes only after a `receive` frees a slot |
| B | `close()` drains buffered values | `[1, 2, 3]` delivered, then iteration ended cleanly |
| C | Pending `send` after `close(reason)` rejects | `ChannelClosedError` with `reason: { tag: "shutdown" }` |
| D | A `signal` cancels a pending `receive` | Pending receive rejects when the controller aborts |
| E | Capacity validation | `0`, `-1`, `0.5`, `NaN`, `Infinity` all rejected with `RangeError` at `createChannel(...)` |

**Cancellation composes with the parent scope.** If the consumer task throws inside `group`, sibling cancellation aborts the producer's pending `send`. The producer's `for await` exits cleanly through the rejection. No orphaned sends, no leaked consumers, no half-drained buffer.

This is Go's `chan` with structured-concurrency parents. Kotlin's `Channel` without coroutines. It fills the gap between "raw async iterator" and "RxJS observable" for owned producer-consumer work.

---

## Bad-batch bisection -- one rotten document doesn't poison the embedding

A real RAG pipeline failure mode: the provider returns 400 for a mixed batch because **one** of the documents is malformed. With `Promise.all`, the whole batch fails, the budget is spent on nothing, and the next 99 documents get re-embedded on retry.

WorkIt ships `embedAllBisection` that splits the failed batch and recovers the good vectors:

```ts
// samples/embed-bisection.sample.js
const result = await group(
  async () => embedAllBisection(["alpha", "bad-doc", "gamma"], {
    async embedBatch(inputs) {
      if (inputs.includes("bad-doc")) throw new BadBatchError("provider rejected mixed batch");
      return inputs.map((input) => [input.length]);
    },
  }, {
    batchSize:   3,
    onError:     "continue",
    countTokens: (input) => input.length,
  }),
  { context }
);

// Asserted by the sample:
//   result.results contains the vectors for "alpha" and "gamma"
//   result.errors  contains exactly one entry pointing at "bad-doc"
//   tokensSpent reflects only the successful work
```

`BadBatchError` is the contract. Throw it from `embedBatch` and the helper bisects: split the batch in halves, retry each half, isolate the rotten document, keep the good vectors. Token budget accounting follows the actual successful work -- you don't pay for the failed mixed batch twice.

```sh
npm run sample:bisection
```

This is the difference between "batch job dies at 2 a.m. and the on-call resyncs the warehouse" and "batch job logs the bad ID and keeps going."

---

## Streaming STT with disconnect cleanup (revisited)

Article 1 showed this. Now you can read the backpressure underneath it:

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

When the user closes their laptop:

1. `socket.signal` aborts.
2. `transcribeStream` propagates the abort to the inflight `transcribe()` body.
3. The provider's HTTP request aborts at the `AbortSignal` boundary.
4. The async generator's `finally` runs, closing the microphone source.
5. The `for await` loop exits.

Tracked sample: **`sample:stt-disconnect`** -- disconnects mid-second-chunk, asserts the provider was cancelled, the source was closed, and the cancel reason kind is `manual`.

---

## How WorkIt's streaming primitives compare

| Library | Backpressure | Cancellation | Structured concurrency | Note |
|---|---|---|---|---|
| **WorkIt `work().stream()`** | yes producer pauses on consumer | yes via `ctx.signal` and `break` | yes scope-owned | Backpressure between producer and consumer in one pipeline |
| **WorkIt `createChannel`** | yes blocking `send`/`receive` | yes via signal + scope cancel | yes scope-owned | Backpressure between independent tasks |
| Node.js `Readable` stream | yes via `highWaterMark` | partial via `destroy()` | no no scope | No structured cancel propagation |
| RxJS observable | no by default; pressure operators are opt-in | yes on `unsubscribe` | per-subscription, not per-scope | Different model: events, not owned tasks |
| `p-queue` | partial (concurrency limit) | no | no | Bounds in-flight, not producer pull |
| Async generator (raw) | yes pull-based | partial via `return()` | no | No bounded concurrency without manual scaffolding |

WorkIt's streaming and channel primitives are the only ones in the table that tie backpressure **to ownership** -- cancel the scope, the channel closes, the in-flight work aborts, and cleanup runs.

---

## Receipts

```sh
node benchmarks/articles/09-stream-1b-lazy.mjs        # naive 281 vs WorkIt 40
node benchmarks/articles/10-stream-slow-consumer.mjs  # producer overshoot 15 vs bound 17
node benchmarks/articles/11-channel-contract.mjs      # 5 channel scenarios
node benchmarks/articles/run-all.mjs                  # full article suite
```

Production-side gates that back the same primitives:

| Claim | Evidence |
|---|---|
| 1 B virtual stream consumed = 25 | `sample:1b` produces <= TAKE+CONCURRENCY items, asserted in CI. Reproduced by [`09-stream-1b-lazy.mjs`](../benchmarks/articles/09-stream-1b-lazy.mjs). |
| 1 M item slow-consumer gate | `check:stream-memory` -- heap growth bounded, max active capped, and producer pull remains demand-limited. |
| Channel backpressure on capacity 2 | [`11-channel-contract.mjs`](../benchmarks/articles/11-channel-contract.mjs) verifies the third send blocks until the first receive. |
| Channel close + drain | [`tests/evidence/correctness/runtime-contracts.mjs`](../tests/evidence/correctness/runtime-contracts.mjs) verifies buffered values drain before `done: true`. |
| Channel cancel via signal | Channel contract coverage verifies pending receives reject with the cancel reason. |
| Channel composes with `group()` | Channel contract coverage verifies producer/consumer pipelines deliver values in order. |
| `work().inParallel(N)` cap | Property test (`fast-check`): for any (N, total), `maxActive <= N`. |
| STT disconnect | `sample:stt-disconnect`: provider cancelled, source closed, reason kind = `manual`. |

Run them:

```sh
npm run sample:1b
npm run sample:stream
npm run sample:embed100k
npm run sample:bisection
npm run sample:stt-disconnect
```

---

## What's coming

Now you have a producer that paces itself to the consumer, a channel that closes when its scope cancels, and a stream that exits cleanly when the user closes the tab.

Tomorrow we add the next ownership primitive on top: **the budget**.

A `$0.50` `CostBudget`. A `100,000`-token `OpenAITokens`. A `5`-tool-call `AgentToolCalls`. Atomic across all parallel children. Inheritable through scope context. Shadowed by inner scopes for sub-budgets. Overrun cancels with `CancelReason { kind: "budget" }` and partial results stay.

The runtime change underneath this is context overlay lookup: 100 `.with()` calls over a 5,000-key context bag moved from tens of milliseconds in the inline clone baseline to well under the 10 ms gate, without changing a line of public API. The bench in the next article shows the representative timing.

The point is not simply "we have budgets." Many frameworks expose budgets. The stronger claim is **budgets that compose with cancellation, race, retry, hedge, fallback, channels, and streams** under one ownership tree.

---

## Source, Benchmarks, And Evidence

- Source: https://github.com/WorkRuntime/workit
- Article source: https://github.com/WorkRuntime/workit/blob/main/articles/04-backpressure-for-streaming-pipelines.md
- Reproduce: `npm run bench:articles` and `npm run test:evidence`
