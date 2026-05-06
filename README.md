# WorkJS

> **Author:** Admilson B. F. Cossa

Structured concurrency for TypeScript.

WorkJS is an early structured-concurrency runtime for building async TypeScript systems where work has ownership, cancellation has a reason, cleanup is guaranteed, and observability is part of the contract.

The goal is simple: make async code feel as natural as `Promise` and `async/await`, while giving production systems the safety properties that raw promises do not provide on their own.

## Project Status

WorkJS currently contains a working core engine with strict TypeScript compilation and a focused `node:test` sanity suite.

This repository should not imply public package availability until the API, tests, release process, license, and provenance story are complete. Examples below use only the current engine surface.

## Why WorkJS Exists

Modern TypeScript applications routinely coordinate many concurrent operations:

- API calls
- queue jobs
- file processing
- AI agent steps
- embedding batches
- search and retrieval pipelines
- background audits
- retries, timeouts, and fallbacks

Raw async code makes it too easy to create orphaned work, miss cleanup, leak retries, ignore cancellation, or lose observability. WorkJS is designed to make those failure modes hard to ship.

## Core Principles

- **Plain TypeScript first:** no generators, no custom effect language, no hidden control flow.
- **No orphaned work:** every task belongs to a scope unless it is explicitly detached.
- **Cancellable by contract:** cancellation has a typed reason and propagates through the task tree.
- **Cleanup is guaranteed:** deferred cleanup runs before a scope closes.
- **Observable by default:** task and scope transitions are visible through typed events.
- **Conservative defaults:** no silent retries, timeouts, provider routing, or background work.
- **Production scale:** bounded concurrency, backpressure, idempotency, and cost-aware telemetry are first-class concerns.

## Current Engine Surface

```ts
import { group } from "workjs"

const result = await group(async task => {
  const plan = await task(planWork)

  task.background(writeAuditEvent)

  return task(async ctx => executeStep(plan.next, ctx.signal))
})
```

In this model:

- the group owns every child task
- failures cancel sibling work
- cleanup runs before the group resolves
- cancellation can abort signal-aware APIs such as `fetch`
- events describe what started, succeeded, failed, retried, or cancelled

## Primary Workloads

The current scope engine is designed for TypeScript workloads where concurrent async work must be owned and cancellable:

- agent task trees
- RAG ingest
- embedding batches
- streaming transcription
- multi-provider races
- budget-aware execution
- long-running tool calls

## Design Guarantees

WorkJS should only be considered ready when these guarantees are backed by tests and reproducible measurements:

- a scope cannot close before owned child work settles
- scope cancellation aborts children and runs cleanup
- non-background child failure cancels siblings
- every exported engine function has happy-path and error-path coverage
- every error path emits a safe typed event
- telemetry is bounded in volume, cardinality, and retention

## Repository Layout

```txt
src/
  index.ts
  engine/
    context.ts
    duration.ts
    event-bus.ts
    scope.ts
  types/
    index.ts
tests/
  unit/
    sanity.test.js
```

The root `docs/` folder and `AGENTS.md` are local project context and are intentionally ignored by git.

## Quality Gates

Use the local verification command before staging production changes:

```sh
npm run verify
```

Current gates:

- strict TypeScript compile
- declaration output
- Node test runner sanity suite
- zero runtime dependencies
- ignored local specifications and debug artifacts

## Repository Rules

Production code, tests, documentation, and release artifacts must be committed intentionally.

Local-only agent instructions, private specifications, temporary tests, debug scripts, scratch reproductions, generated output, dependency folders, caches, and environment files must stay out of git.

Every necessary committed file must include language-appropriate documentation and author metadata where the file format supports it.

## Commit Standard

Commits should be small, scoped, and written in the imperative mood.

Good examples:

- `Initialize project README`
- `Add scope cancellation contract`
- `Implement duration parser`
- `Cover retry timeout behavior`

Avoid vague commits such as `update`, `changes`, or `fix stuff`.

## Release Readiness

Before any public release, the project needs:

- finalized public API
- implementation backed by focused tests
- strict TypeScript configuration
- package exports and build pipeline
- benchmark and bundle-size checks
- license decision
- contribution guide
- release and provenance process

## License

License not selected yet.
