<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# WorkIt Claim Evidence

`claims.json` is the publication source of truth for WorkIt claims. README and
articles consume this ledger; they do not invent new claim status.

The evidence hierarchy is:

```txt
runtime source + npm run verify
benchmarks/articles/run-all.mjs
tests/evidence/run-all.mjs
evidence/claims.json
coverage/evidence/latest.json (temporary, ignored)
-> README, articles
```

## Claim Classes

| Class | Use |
|---|---|
| `security` | Abuse-resistance or boundary-hardening proof. |
| `correctness` | Runtime behavior invariant. |
| `lifecycle` | Cancellation, cleanup, ownership, orphan prevention. |
| `release` | Package, provenance, SBOM, public artifact, policy gate. |
| `performance` | Latency, memory, throughput, benchmark contract. |
| `product-decision` | Explicit design choice rather than a bug. |

Do not label every adversarial proof as security. A proof is security only when
the impact and invariant are security-relevant.

## Commands

```sh
npm run verify
npm run bench:articles
npm run test:evidence
npm run check:evidence-ledger
```

`benchmarks/results/articles.latest.json` stores the captured article benchmark
run used by README and articles for representative values. The benchmark
assertions remain the portable proof.

`test:evidence` rebuilds the package, executes every proof declared in
`tests/evidence/manifest.mjs`, and writes the per-claim actual results to the
ignored `coverage/evidence/latest.json` artifact. The capture includes a SHA-256 digest over the
claim ledger, package contract, API snapshots, runtime source, and executable
evidence. `check:evidence-ledger` rejects missing claims, missing proof files,
unregistered evidence scripts, failing results, or a stale digest.

## Evidence Stack

| Layer | Source of truth | Role |
|---|---|---|
| Runtime | `npm run verify` | package, tests, coverage, API, size, security, and release gates |
| Article benches | `benchmarks/articles/run-all.mjs` | side-by-side behavior used in public articles |
| Captured bench run | `benchmarks/results/articles.latest.json` | representative publication values for this revision |
| Claim ledger | `evidence/claims.json` | claim IDs, class, proof path, invariant, status, and limitation |
| Evidence tests | `tests/evidence/run-all.mjs` | curated lifecycle, correctness, security, release, and performance proofs |
| Temporary captured results | `coverage/evidence/latest.json` | ignored environment, source digest, elapsed time, and actual result used by the current verification run |

## Publication Rule

README summarizes. Articles teach. Neither invents claim status. Public prose
must cite one of the executable sources above, and security claims must stay
security-specific rather than using "security" as a label for every adversarial
or lifecycle proof.

Historical tags are never rewritten: later backfills remain explicitly labeled
as backfills in the ledger.

## Oryn 0.6.0 Canary

`oryn-candidate-canary.v0.6.0.json` is the redacted external-integration receipt
for `REL-011`. It binds the packed `0.6.0` tarball hash, WorkIt and Oryn commits,
real provider routing decisions, daemon-backed receipt round-trip, durable replay,
and controlled retry-budget, deadline, and user-input-stop scenarios. The receipt
retains environment warnings and limitations; it contains neither provider response
bodies nor credentials. `release/oryn-candidate-canary.mjs` validates this receipt
as part of `test:evidence`, and the evidence-source digest includes the receipt.

## Oryn 0.6.1 Hardening Canary

`oryn-hardening-canary.v0.6.1.json` is the redacted packed-artifact receipt for
`REL-013`. It binds the deterministic `0.6.1` tarball to the WorkIt release
commit, Oryn base commit, canary script, package manifest, and lockfile hashes.
The real provider quality fallback and daemon-backed durable replay passed,
along with controlled retry-budget, aggregate-deadline, and user-input-stop
scenarios. `release/oryn-hardening-canary.mjs` validates the receipt during
`test:evidence`.
