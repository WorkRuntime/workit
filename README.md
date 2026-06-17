<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

<p align="center">
  <img src="apps/use-cases-site/public/workit-wordmark.png" alt="WorkIt" width="384">
</p>

# WorkIt

WorkIt is a TypeScript structured concurrency runtime for Node.js server
runtimes.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![npm](https://img.shields.io/npm/v/@workit/core?label=npm)](https://www.npmjs.com/package/@workit/core)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](packages/core/package.json)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12807/badge)](https://www.bestpractices.dev/projects/12807)

WorkIt owns related async work through scope, cancellation, cleanup, context,
events, and child task lifecycles.

## Install

```sh
npm install @workit/core
```

```ts
import { run, work } from "@workit/core";
```

WorkIt is Apache-2.0 licensed. Contributions are welcome through issues and
pull requests; please follow [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Live examples: <https://workruntime.github.io/workit/>

npm package: <https://www.npmjs.com/package/@workit/core>

Changelog: [CHANGELOG.md](CHANGELOG.md)

## Versioning

WorkIt follows semver with a stricter release discipline:

- Patch releases, such as `0.1.x`, are for fixes, build/release hardening,
  layout migrations, documentation, and evidence updates. They must not add new
  public runtime APIs.
- Minor releases, such as `0.2.0`, may add new subpaths or feature families when
  they are backed by tests, evidence, package-consumer checks, and
  documentation.
- The root `@workit/core` import remains size-disciplined. New heavier
  capabilities should live in subpaths or companion packages.
- `1.0.0` will mark a frozen public API and long-term compatibility policy, not
  a shortcut for credibility. Current `0.x` releases are validated and usable,
  with changes managed through semver and release notes.

## Citation

If you use WorkIt in research, benchmarks, or reproducible artifacts, please
cite the software release you used:

```bibtex
@software{workit2026,
  author = {Admilson B. F. Cossa},
  title = {WorkIt: A TypeScript Structured Concurrency Runtime for Node.js Server Runtimes},
  year = {2026},
  url = {https://github.com/WorkRuntime/workit},
  version = {0.3.0},
  license = {Apache-2.0}
}
```

## Repository Layout

This repository uses a monorepo layout. The published package contract is still
owned by `packages/core`.

| Path | Purpose |
|---|---|
| `packages/core` | Source, tests, samples, evidence, benchmarks, and release scripts for `@workit/core`. |
| `apps/use-cases-site` | GitHub Pages site with executable WorkIt examples. |
| `articles` | Public article drafts and released article materials. |

## Package Contract

The monorepo layout must not change how users install or import WorkIt.

Stable consumer paths for this release line:

```txt
@workit/core
@workit/core/activity
@workit/core/ai
@workit/core/analysis
@workit/core/channel
@workit/core/diagnostics
@workit/core/ledger
@workit/core/observability
@workit/core/otel
@workit/core/replay
@workit/core/resources
@workit/core/time-policy
@workit/core/worker
```

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
