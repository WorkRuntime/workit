<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Changelog

## Unreleased

## 0.6.1

- Correct public documentation that still described the already-published
  candidate-policy subpath as an unavailable release candidate.
- Keep the `0.6.0` runtime and public export surface unchanged while freezing
  declaration snapshots for every published TypeScript entrypoint.
- Add installed-package compatibility checks against `0.6.0`, deterministic
  package-build verification, and Node 20.11, 22, and 24 CI coverage.
- Keep `ContextBagImpl` public for the 1.0 contract and document its bounded,
  immutable context role.
- Update development-only verification tooling to patched releases; the
  published package continues to have zero runtime dependencies.
- Normalize npm repository metadata and refresh release evidence and
  provenance gates for the `0.6.1` artifact.

## 0.6.0

- Add the explicit `@workit/core/candidates` subpath with deterministic
  `firstAcceptable()` selection, provider-neutral failure dispositions, typed
  semantic quality decisions, existing retry/deadline/budget reuse, and bounded
  redacted candidate-attempt evidence.
- Add conservative built-in taxonomy for WorkIt cancellation, timeout, and
  retry-budget exhaustion while leaving unknown provider failures under the
  caller's explicit classifier policy.
- Keep real cancellation authoritative, return terminal and user-input stops as
  exhaustive typed results, and leave root runtime exports unchanged.
- Add ESM, CommonJS, strict TypeScript, unsupported-runtime, unit, property, and
  installed-package coverage for candidate policy contracts.
- Add a manifest-driven evidence runner, per-claim actual-result capture in the
  ignored coverage directory, and a source-digest ledger gate that rejects
  missing, failing, unregistered, or stale evidence.

## 0.5.0

Add runtime deadline introspection, shared retry admission limits, and bounded
attempt evidence to the core execution contract.

- Add `TaskContext.deadlineAt`, reporting the earliest effective absolute
  deadline inherited through the owning scope tree and active timeout/deadline
  wrappers. Task bodies must still cooperate through `ctx.signal`.
- Add `RetryOpts.retryBudget`, charged through the existing atomic scope budget
  mechanism before each additional retry is admitted. The initial attempt is
  not charged.
- Add the `task:attempt` lifecycle event and derive generic receipt attempt
  evidence from the outer task retry boundary. Exhaustive `TaskEvent` consumers
  must add a `case "task:attempt"` branch when upgrading from `0.4.x`.
- Add `createAttemptRecorder()` to `@workit/core/replay` for bounded,
  secret-redacted caller metadata and validated reason codes at explicit
  provider or activity boundaries.
- Extend `@workit/core/time-policy` with retry budget snapshots and conservative
  aggregate demand checks for nested retry policies.
- Isolate event-context and observer failures so telemetry cannot interrupt
  cancellation, deadline timers, or scope close transitions.
- Clarify that `TaskOpts.idempotencyKey` provides in-flight coalescing inside
  one live scope, not durable idempotency or restart replay.
- Expand ESM, CommonJS, strict TypeScript, framework, evidence, and lifecycle
  coverage for the new contracts.
- Require non-dry-run provenance publishing from a signed tag matching the
  package version.
- Update the release build/test toolchain to patched `esbuild` and `wrangler`
  versions; the published package still has zero runtime dependencies.
- Keep the root bundle below its ratcheted size limits.

## 0.4.0

Add runtime contract and evidence hardening behind explicit subpaths. The root
import remains unchanged.

- Add `@workit/core/contracts` for declared cancellable and shielded task
  composition. This is a compile-time intent contract; it does not prove that
  arbitrary task bodies observe `ctx.signal`.
- Add `@workit/core/fault` for bounded in-process lifecycle fault scenarios
  over the real WorkIt scope engine. This is not OS fault injection, process
  crash recovery, network chaos testing, or deterministic scheduler replay.
- Add declared agent tool capability checks to `@workit/core/ai`, including a
  typed `AgentCapabilityError` and denial events before denied tool bodies run.
- Extend `@workit/core/ledger` with caller-owned SQLite and Postgres receipt
  ledger adapters. These adapters define a receipt storage contract; they do
  not make WorkIt a database framework.
- Add executable evidence for typed cancellation contracts, bounded fault
  scenarios, agent authority, SQL receipt ledgers, and resource audit visibility.
- Extend package-consumer coverage for the new subpaths across ESM, CommonJS,
  strict TypeScript, framework fixtures, and browser/worker unsupported-runtime
  checks.
- Keep the root `@workit/core` import and bundle budget unchanged.

## 0.3.0

Add the `@workit/core/time-policy` planning subpath for declared async time
policy analysis. The root import remains unchanged.

- Add `planTimePolicy()` for conservative upper-bound planning across attempt,
  series, parallel, retry, hedge, timeout, and deadline policy trees.
- Add `estimateRetry()` and `estimateHedge()` helper planners aligned with the
  runtime retry delay and hedge stagger contracts.
- Add bounded correctness evidence for retry/deadline planning, the finite
  time-policy cost model, and nested composition rules.
- Add package-consumer coverage for the new subpath across ESM, CommonJS, and
  strict TypeScript fixtures.
- Document that the planner analyzes declared policy bounds before execution; it
  does not run task bodies or prove wall-clock scheduler behavior.

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

## 0.1.4

Add the WorkIt use-cases site and its executable runtime-backed examples. The
package runtime API remains unchanged.

- Add generated evidence snapshots, runtime smoke checks, and data-contract
  checks for the site.
- Add repeated article-benchmark execution and captured distribution results.
- Add a conversation-agent sample and public links to the site and npm package.

## 0.1.3

Harden OpenTelemetry compatibility, security automation, and runtime property
coverage without changing the core API.

- Fix the optional OpenTelemetry subpath import from synthetic Node evaluation
  entrypoints and add regression coverage.
- Add seeded property tests for core lifecycle invariants.
- Add CodeQL, OpenSSF Scorecard, and security-policy hardening.

## 0.1.2

Publish the first seven-part technical article series and its executable
evidence package.

- Add 19 self-contained behavioral benchmark scenarios and captured results.
- Add the initial public claim ledger and curated evidence runner.
- Expand the public README and package scripts used to reproduce article claims.

## 0.1.1

Improve optional OpenTelemetry diagnostics and release documentation while
keeping the public runtime contract compatible with 0.1.0.

- Explain missing optional peer dependencies at the OpenTelemetry boundary.
- Add installed-package consumer coverage for that boundary.
- Stabilize the circuit-breaker timing assertion and publish the release guide.

## 0.1.0

Initial public release of `@workit/core` as a zero-runtime-dependency structured
concurrency runtime for Node.js and TypeScript.

- Ship owned scopes, task handles, cancellation, cleanup, retries, timeouts,
  bounded parallel work, backpressure, budgets, diagnostics, channels, AI
  helpers, telemetry adapters, and worker offload behind explicit exports.
- Publish ESM, CommonJS, TypeScript, security, package-consumer, benchmark,
  memory, soak, and provenance gates.
