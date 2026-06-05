<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Changelog

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
