<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->
# Security Policy

## Supported Versions

WorkJS is pre-release software. Security fixes apply to the current `0.x`
development line until a stable support policy is published.

## Reporting A Vulnerability

Do not open a public issue for suspected vulnerabilities.

Security contact: admilsoncossa@gmail.com

PGP encryption: request the maintainer's current public key through the security
contact before sending secrets, exploit details that include credentials, or
tenant-sensitive material. Do not attach secrets to an unencrypted first report.

Send a private report to the project maintainer with:

- affected version or commit
- operating system and Node.js version
- minimal reproduction
- impact assessment
- whether secrets, tenant data, billing controls, or cancellation guarantees are affected

The maintainer should acknowledge valid reports within 72 hours and publish a
fix, mitigation, or status update as soon as practical.

## Security Boundary

WorkJS is a local structured-concurrency runtime. It does not authenticate
users, authorize actions, encrypt payloads, or provide a durable workflow
ledger. Applications remain responsible for tenant isolation, provider
credentials, authorization, persistence, and external network policy.

The core package must keep these guarantees:

- zero runtime dependencies
- no core networking imports or remote telemetry clients
- bounded exporter queues for opt-in telemetry bridges
- caller-owned telemetry sanitizers before events leave the process
- no skipped or focused tests in release verification
- 100% statement, branch, function, and line coverage
- CycloneDX SBOM generation and validation
- production dependency vulnerability audit
- package dry-run inspection before publication

## Release Provenance

Public releases must be built from a clean worktree and published with npm
provenance enabled. A release is not approved unless these commands pass:

```sh
npm run verify
npm run test:coverage
npm run check:vulnerabilities
npm run check:sbom
npm pack --dry-run --json
```

The provenance workflow is defined in `.github/workflows/release-provenance.yml`.
Registry dry-runs and real publication are intentionally blocked while
`package.json` has `private: true`. Final release requires a separate scoped
commit that proves `@workjs` npm scope ownership, flips `private` to `false`,
and runs:

```sh
npm publish --provenance --access public --dry-run
```

The package must not publish source maps, local docs, tests, secrets, temporary
files, debug output, or private agent instructions.

## Responsible Disclosure Scope

Reports are in scope when they affect:

- cancellation integrity
- no-orphan guarantees
- budget accounting or cost-cap bypass
- context isolation across requests
- telemetry exporter isolation
- package contents or supply-chain integrity
- worker-thread offload boundaries

Worker-thread offload is an explicit local execution boundary. `offload()`
accepts only local file URLs or paths controlled by the application; inline
`data:` modules and remote `http:`/`https:` modules are rejected before import.
When `offload()` is given a timeout, WorkJS terminates the worker thread on
timeout so non-cooperative worker code cannot keep running in-process. In-process
helpers such as `run.uncancellable()` remain cooperative shields; JavaScript code
that ignores abort signals cannot be forcibly stopped without a worker/process
boundary.

Out of scope:

- vulnerabilities in downstream application code
- denial-of-service claims that require intentionally unbounded user code inside a task
- unsupported browser, edge, or Cloudflare Worker execution
