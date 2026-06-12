<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Changelog

## Unreleased

## 0.2.0

Add the core ownership and evidence foundation as explicit `@workit/core`
subpaths. The root import remains unchanged.

- Add `@workit/core/replay` for lifecycle receipt recording and redaction.
- Add `@workit/core/ledger` for memory and file receipt ledgers.
- Add `@workit/core/analysis` for receipt and caller-provided protocol
  verification.
- Add `@workit/core/activity` for explicit terminal activity boundaries.
- Add `@workit/core/resources` for lazy, shared, and scope-owned resource
  helpers.
- Add package-consumer coverage for the new subpaths across ESM, CommonJS, and
  strict TypeScript fixtures.
- Add executable evidence for receipts, ledgers, analysis, activity terminal
  replay, and resource ownership.
- Keep the root `@workit/core` bundle size unchanged.
- Improve npm package discoverability with targeted package keywords and a more
  specific package description.
- Clarify npm README examples for retry policies, `TaskFn` invocation,
  `renderTree(scope.status())`, and `work().do()` fail-fast output.
- Normalize activity results before persistence so first execution and replay
  return the same JSON value.
- Derive the OpenTelemetry instrumentation version from package metadata.
- Document the buffered `work().do()` contract and cooperative cancellation
  boundary for hedged work.

## 0.1.5

Move `@workit/core` to `packages/core` monorepo layout. No public API changes.

This release prepares the repository for future WorkIt extensions while keeping
the published package contract unchanged.

- `@workit/core` source, tests, samples, benchmarks, evidence, and release
  scripts now live under `packages/core`.
- Root package is now a private workspace coordinator.
- Existing install and import paths remain unchanged.
- Existing package exports remain unchanged.
- Root runtime bundle size remains unchanged.
- Release provenance workflow now publishes the workspace package.
- Use-cases site now resolves the real local package from `packages/core`.

This is an infrastructure release only. New runtime capabilities are planned for
the next minor line after the monorepo layout is validated in CI and npm.
