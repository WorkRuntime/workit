<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# WorkIt Article Series

Seven articles. Each opens with code and a concrete problem, then links the
claim to executable evidence. The argument builds from plain `async` / `await`
ownership to worker boundaries, streaming backpressure, budgeted cleanup,
observability, and finally agent tool lifecycles.

The sequence focuses on practical high-pressure workloads: AI agents, provider
racing, streaming STT, 100K-document budget caps, 1-billion-row pipelines,
worker hard-kill against a CPU spinner, local-first observability, and the
`runAgent` / `AgentScope` primitive.

## Reading Order

1. [`01-owned-async-work.md`](01-owned-async-work.md) -- why promises model values, not ownership.
2. [`02-concurrency-retry-timeout.md`](02-concurrency-retry-timeout.md) -- composing pool, race, any, retry, timeout, fallback, and hedge policies.
3. [`03-cancellation-and-worker-boundaries.md`](03-cancellation-and-worker-boundaries.md) -- cooperative cancellation and hard worker termination.
4. [`04-backpressure-for-streaming-pipelines.md`](04-backpressure-for-streaming-pipelines.md) -- bounded producers for RAG, STT, and large streams.
5. [`05-resource-safety-and-budgeted-work.md`](05-resource-safety-and-budgeted-work.md) -- bracketed cleanup, uncancellable sections, and request budgets.
6. [`06-observability-without-core-bloat.md`](06-observability-without-core-bloat.md) -- diagnostics, telemetry, sampling, and exporter isolation.
7. [`07-agent-scope-and-tool-lifecycles.md`](07-agent-scope-and-tool-lifecycles.md) -- agent tools, budgets, events, and replayable execution logs.

## Editorial Rules

- **Code first.** Open with a runnable snippet that is the point.
- **Claims map to gates.** Every number cited maps to `npm run verify`, `npm run bench:articles`, `npm run test:evidence`, or [`evidence/claims.json`](../evidence/claims.json).
- **No theatrical comparisons.** Do not say "10x faster than X" without a benchmark. Say what the executable invariant verifies.
- **Ownership/composition framing.** External libraries may expose cancellation hooks; WorkIt's claim is that cancellation, cleanup, retry, timeout, budgets, backpressure, and diagnostics compose under one owner.
- **Agent and data-plane scenarios stay first-class.** Provider racing, agent cancellation, RAG ingest, streaming STT, embedding pipelines, token/cost/tool-call budgets are the core scenarios.
- **Honesty about layers.** Cooperative cancellation is labeled cooperative. Worker hard-kill is labeled worker-boundary hard kill. Browser/edge are labeled unsupported.

## Headline Numbers

These numbers are reproducible from the gates and captured benchmark result.
Use representative timing language unless a value is asserted by a gate.

```txt
214 unit tests, 100% line/branch/function coverage
0 production dependencies, 0 install scripts, 0 networking imports in core dist
14,175 B core-group-import minified / 4,835 B gzip
29,255 B public-api minified / 9,694 B gzip
126,136 B max heap growth in 100k task soak @ concurrency 128
1,000,000 logical items in stream memory gate, bounded heap
1,000,000,000 logical items in 1B claim sample, <= TAKE+CONCURRENCY produced
well under the 10 ms gate for 100 .with() calls over 5,000 keys
200ms timeout vs CPU spinner: late-marker file does not exist
19 article-series benchmarks, all green
tracked claim evidence suite classified by lifecycle/correctness/security/release/performance
```

## Reproducing The Receipts

```sh
npm run verify
npm run bench:articles
npm run test:evidence

npm run sample:race
npm run sample:agent
npm run sample:embed100k
npm run sample:1b
npm run sample:worker
npm run sample:stt-disconnect
npm run check:public-proof
```

The captured article benchmark result for this publication revision is
[`benchmarks/results/articles.latest.json`](../benchmarks/results/articles.latest.json).

## The Single Labeled Gap

Browser and edge runtimes resolve to an explicit unsupported boundary today.
A dedicated edge-safe context runtime, semantic invariant tests, and
installed-tarball Worker fixtures are future work. Node 20+ ESM/CJS, supported
server-shaped fixtures, and the package-consumer matrix run from the installed
artifact under the repository gates.
