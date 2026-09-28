<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

## Problem

<!-- Describe the concrete failure mode or contract gap. -->

## Change

<!-- Describe one coherent change. Avoid unrelated cleanup. -->

## Ownership boundary

<!-- Identify the existing owner reused by this change. Explain any new public surface. -->

## Evidence

<!-- List exact commands, tests, fixtures, and observable results. -->

## Limitations

<!-- State what this change does not prove or support. -->

## Checklist

- [ ] Tests were added or updated before behavior changed.
- [ ] `npm run test:coverage` passes with 100% statements, branches, functions, and lines.
- [ ] `npm run verify` passes, or an environmental limitation is documented.
- [ ] Public API, declarations, package exports, and compatibility fixtures were updated when applicable.
- [ ] Root size and zero-runtime-dependency contracts remain intact.
- [ ] Cancellation, cleanup, retries, deadlines, and budgets still have one owner.
- [ ] New claims identify proof paths, expected invariants, and limitations.
- [ ] Logs, receipts, screenshots, and fixtures contain no secrets or private consumer data.
