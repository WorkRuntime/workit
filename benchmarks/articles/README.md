<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Article-Series Benchmarks

Self-contained, side-by-side runtime benches that back the WorkIt runtime claims made in the [WorkIt article series](../../articles/). Zero external dependencies -- the promise-helper baselines are inlined as minimal implementations of the unsignaled behavior patterns being compared in [`lib/baselines.mjs`](lib/baselines.mjs).

## Why this folder exists

The articles compare WorkIt to native promises and small local baselines that model common promise-helper patterns. Runtime claims that are not reproducible from the published package stay out of the series.

Each bench in this folder runs both implementations against the same workload, captures timestamps for every observable event (`startedAt`, `settledAt`, `signalAbortedAt`, `deferRanAt`), and emits one JSON record. If a WorkIt invariant regresses, the bench's `assert.*` calls fail the run.

## What's measured

| File | Article section | What it verifies |
|---|---|---|
| [`01-run-all-vs-promise-all.mjs`](01-run-all-vs-promise-all.mjs) | `run.all` | Native `Promise.all` lets losers run for the full latency past rejection. `run.all` cancels them at the AbortSignal boundary; defer cleanups run before the outer promise rejects. |
| [`02-run-race-vs-promise-race.mjs`](02-run-race-vs-promise-race.mjs) | `run.race` | Native `Promise.race` leaves losing fetches running. `run.race` aborts losers and tags them with `CancelReason.kind === "race_lost"`. |
| [`03-run-any-vs-promise-any.mjs`](03-run-any-vs-promise-any.mjs) | `run.any` | Native `Promise.any` keeps slower siblings running after the first success. `run.any` cancels remaining siblings, defer runs. |
| [`04-pool-vs-semaphore.mjs`](04-pool-vs-semaphore.mjs) | `run.pool` | A `p-limit`-style semaphore lets queued items keep running after one throws. `run.pool` cancels queued and in-flight on first failure. |
| [`05-retry-on-cancel.mjs`](05-retry-on-cancel.mjs) | `run.retry` | A signal-unaware retry loop can run extra attempts after cancel was requested. `run.retry`'s sleep is signal-aware and the task settles as `cancelled`, not `failed`. |
| [`06-hedge-tied-requests.mjs`](06-hedge-tied-requests.mjs) | `run.hedge` | `run.hedge` fires extra attempts only after the configured `after` interval, bounds them by `max`, and cancels every non-winning attempt. The fast scenario fires no hedge at all. |
| [`07-worker-hard-kill.mjs`](07-worker-hard-kill.mjs) | `offload` (article 03) | A non-cooperative CPU spin loop on the main thread cannot be aborted; the late-marker file is written. Inside `offload({ timeout })`, the worker thread is terminated by the host; the marker file does **not** exist on disk. The bench `stat()`s the marker file. |
| [`08-uncancellable-shield.mjs`](08-uncancellable-shield.mjs) | `run.uncancellable` (article 03) | Three scenarios: (A) parent cancel during body -- body completes, then original cancel rethrows; (B) shield's own timeout -- body sees `TimeoutError` on its local signal; (C) nested shields -- outer cancel reason preserved through both layers. |
| [`09-stream-1b-lazy.mjs`](09-stream-1b-lazy.mjs) | `work().stream()` (article 04) | An eager prefetch buffer pulls 281 items from a 1B source for 25 consumed on the captured run. `work().inParallel(16).map().stream()` produces <= 41 items (TAKE + CONCURRENCY) and respects the cap. |
| [`10-stream-slow-consumer.mjs`](10-stream-slow-consumer.mjs) | backpressure (article 04) | A slow consumer (~5 ms per item) holds the producer to <= `CONCURRENCY + 1` items of overshoot. Tracked: producer pacing, max active, post-break in-flight count. |
| [`11-channel-contract.mjs`](11-channel-contract.mjs) | `createChannel` (article 04) | Five contract scenarios: capacity backpressure (third send blocks on a 2-cap channel), close drains buffered values, close rejects pending sends with `ChannelClosedError`, signal cancels a pending receive, capacity validation rejects 0/-1/0.5/NaN/Infinity. |
| [`12-bracket-vs-try-finally.mjs`](12-bracket-vs-try-finally.mjs) | `run.bracket` (article 05) | Five scenarios: success, `use` throws, `acquire` throws (release does not run), parent cancel during `use`, hanging release. Native try/finally with a hanging cleanup never settles; `run.bracket` with `{ timeout }` settles within the bound and emits `task:cleanup_timeout`. |
| [`13-budget-atomicity-and-cancel.mjs`](13-budget-atomicity-and-cancel.mjs) | budgets (article 05) | 100 sibling charges of 0.01 land at exactly 1.00 (no double-charge). A budget set at scope depth 0 cancels with `kind: "budget"` even when the overrun happens at depth 5. The caller's input object is never mutated by the engine. |
| [`14-context-overlay-perf.mjs`](14-context-overlay-perf.mjs) | context overlay (article 05) | The inline Map-clone baseline takes ~32 ms for 100 `.with()` over 5,000 keys on representative runs. The WorkIt overlay is well under the <10 ms gate and at least 10x faster than the inline baseline. Same lookup result. |
| [`15-core-zero-network.mjs`](15-core-zero-network.mjs) | zero-network gate (article 06) | Static walk over `dist/` (excluding the explicit `observability`, `otel`, `worker` subpaths) finds zero matches for `node:http`, `node:https`, raw `http`/`https` imports, or `fetch(...)`. Same property as the production gate, applied to the published artifact. |
| [`16-sampling-and-aggregation.mjs`](16-sampling-and-aggregation.mjs) | sampling (article 06) | 100 root scopes x 5 child tasks. `mode: "all"` exports 1,300 events; `mode: "errors_and_slow"` exports 36 -- a ~36x reduction at 5% slow + 2% errored. Asserts >= 5x. |
| [`17-cardinality-safe-metrics.mjs`](17-cardinality-safe-metrics.mjs) | cardinality (article 06) | The cardinality-safe metric exporter rejects metric points whose label keys are not in the `allowedLabels` allow-list. `task.id` UUIDs and free-form `error.message` are caught at runtime. |
| [`18-diagnostics-finding-codes.mjs`](18-diagnostics-finding-codes.mjs) | diagnostics (article 06) | Five scenarios: healthy snapshot stays `ok`; `old_pending_task`, `scope_cancelling`, `pending_child_scope`, and `cleanup_timeout` (via the events window) each flip the report to `needs_attention`. |
| [`19-agent-scope.mjs`](19-agent-scope.mjs) | `runAgent` / `AgentScope` (article 07) | Five scenarios: tool events bracket execution with stable agentId and monotonic seq; `AgentToolCalls` budget overflow rejects with `BudgetExceededError` keyed `"AgentToolCalls"`; `OpenAITokens` charges via `{ tokens: N }` land at exact spent; parent scope cancel propagates into the tool body's `ctx.signal` with `CancelReason { kind: "manual", tag }`; replayable event log on a 3-tool run has 8 ordered events. |

## Running

From the repo root:

```sh
npm run build                            # produces dist/
node benchmarks/articles/run-all.mjs     # full suite, JSON to stdout
node benchmarks/articles/01-run-all-vs-promise-all.mjs  # one bench
```

Or from this folder:

```sh
npm run bench                            # full suite
npm run bench:run-all                    # bench 01
npm run bench:run-race                   # bench 02
npm run bench:run-any                    # bench 03
npm run bench:pool                       # bench 04
npm run bench:retry                      # bench 05
npm run bench:hedge                      # bench 06
npm run bench:hard-kill                  # bench 07
npm run bench:uncancellable              # bench 08
npm run bench:stream-1b                  # bench 09
npm run bench:stream-slow                # bench 10
npm run bench:channel                    # bench 11
npm run bench:bracket                    # bench 12
npm run bench:budget                     # bench 13
npm run bench:context                    # bench 14
npm run bench:no-network                 # bench 15
npm run bench:sampling                   # bench 16
npm run bench:cardinality                # bench 17
npm run bench:diagnostics                # bench 18
npm run bench:agent                      # bench 19
```

The bench folder has its own `package.json` and **does not appear in the main package's dependency graph**. It is run-only -- clone the repo, run.

## Output shape

Each individual bench prints one JSON object to stdout with the structure:

```jsonc
{
  "bench": "01-run-all-vs-promise-all",
  "native": { /* timings + flags for the native baseline */ },
  "workit": { /* timings + flags for the WorkIt impl */ }
}
```

The runner (`run-all.mjs`) wraps every individual report in a `benches[]` array along with `wallMs` and `exitCode`, so a regression is discoverable both by `assert` failure inside the bench and by the runner's exit code.

## How the baselines stay honest

`lib/baselines.mjs` contains:

- `pLimitLike(N)` -- local semaphore baseline. It models a minimal queue without automatic sibling-failure cancellation. Queued items keep running unless the caller clears the queue.
- `signalUnawareRetryLike(fn, opts)` -- local retry baseline with `setTimeout`-based delay. It intentionally does not observe an abort signal.
- `promiseTimeoutLike(promise, ms)` -- local timeout baseline that wraps a Promise. It intentionally does not abort the underlying work.
- `naiveSleep(ms)` -- signal-unaware sleep used inside native baselines on purpose.
- `sleep(ms, signal)` -- signal-aware sleep used by the WorkIt-side bodies.

These mirror the specific unsignaled behavior patterns under comparison. Some current `p-*` packages expose cancellation hooks; the article's claim is about ownership and composition, not that every helper is incapable of cancellation in every configuration. If an upstream library closes one of these gaps for the exact scenario being tested, the file is updated and so is the article.
