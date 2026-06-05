<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# WorkIt

WorkIt is a TypeScript structured concurrency runtime for Node.js server
runtimes.

The npm package remains `@workit/core`:

```sh
npm install @workit/core
```

```ts
import { run, work } from "@workit/core";
```

Live examples: <https://workruntime.github.io/workit/>

npm package: <https://www.npmjs.com/package/@workit/core>

## Repository Layout

This repository uses a monorepo layout. The published package contract is still
owned by `packages/core`.

| Path | Purpose |
|---|---|
| `packages/core` | Source, tests, samples, evidence, benchmarks, and release scripts for `@workit/core`. |
| `apps/use-cases-site` | GitHub Pages site with executable WorkIt examples. |
| `articles` | Public article drafts that have been intentionally promoted into the repository. |
| `papers` | Public paper assets that have been intentionally promoted into the repository. |

Internal local notes under `docs/` are intentionally ignored and are not part of
the public package or repository contract.

## Package Contract

The monorepo layout must not change how users install or import WorkIt.

Stable consumer paths for this release line:

```txt
@workit/core
@workit/core/ai
@workit/core/channel
@workit/core/diagnostics
@workit/core/observability
@workit/core/otel
@workit/core/worker
```

Package documentation for `@workit/core` lives at
[`packages/core/README.md`](packages/core/README.md).

## Verification

Run the core gates from the repository root:

```sh
npm run verify
npm run test:coverage
npm run check:size
npm run check:package-consumer
```

Run the site gates from the repository root:

```sh
npm run site:build
```
