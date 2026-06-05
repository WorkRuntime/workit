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
```

`benchmarks/results/articles.latest.json` stores the captured article benchmark
run used by README and articles for representative values. The benchmark
assertions remain the portable proof.

## Evidence Stack

| Layer | Source of truth | Role |
|---|---|---|
| Runtime | `npm run verify` | package, tests, coverage, API, size, security, and release gates |
| Article benches | `benchmarks/articles/run-all.mjs` | side-by-side behavior used in public articles |
| Captured bench run | `benchmarks/results/articles.latest.json` | representative publication values for this revision |
| Claim ledger | `evidence/claims.json` | claim IDs, class, proof path, invariant, status, and limitation |
| Evidence tests | `tests/evidence/run-all.mjs` | curated lifecycle, correctness, security, release, and performance proofs |

## Publication Rule

README summarizes. Articles teach. Neither invents claim status. Public prose
must cite one of the executable sources above, and security claims must stay
security-specific rather than using "security" as a label for every adversarial
or lifecycle proof.
