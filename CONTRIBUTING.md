<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->
# Contributing

WorkJS accepts changes only when they preserve the runtime invariants and pass
the full verification gate.

## Development Contract

- Keep the core package local-first: no network clients in core.
- Keep runtime dependencies at zero.
- Add or update tests before changing behavior.
- Keep public API changes intentional and reflected in the API-surface gate.
- Do not commit temporary tests, debug output, generated coverage, or private docs.
- Do not claim browser, edge, or hosted cloud support unless an executable
  fixture proves the real runtime path.

## Verification

Run before proposing a release-quality change:

```sh
npm run test:coverage
npm run verify
```

Coverage must remain at 100% for statements, branches, functions, and lines.

## Commit Style

Use small scoped commits. Prefer prefixes such as:

- `runtime:`
- `observability:`
- `ai:`
- `samples:`
- `tests:`
- `release:`
- `security:`

Each commit should contain one coherent change and the tests needed to prove it.
