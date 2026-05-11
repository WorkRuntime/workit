<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# OpenSSF Best Practices Process

WorkIt uses the OpenSSF Best Practices badge as a public supply-chain hygiene
checklist. The badge must not be shown as passing until the project entry exists
and the checklist is complete.

## Goal

Use the OpenSSF Best Practices process to verify and document:

- public source availability
- Apache-2.0 licensing
- security policy and private vulnerability reporting
- reproducible verification commands
- CI on pull requests and `main`
- dependency update automation
- vulnerability auditing
- static analysis
- signed releases and npm provenance
- package contents discipline

## Required Public Evidence

Before claiming badge status, verify these repository facts:

```sh
npm run verify
npm run test:coverage
npm run test:evidence
npm run bench:articles
npm pack --dry-run --json
```

The public evidence files are:

```txt
README.md
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
LICENSE
evidence/claims.json
evidence/README.md
benchmarks/results/articles.latest.json
.github/workflows/ci.yml
.github/workflows/codeql.yml
.github/workflows/scorecard.yml
.github/workflows/release-provenance.yml
.github/dependabot.yml
```

## External Badge Steps

1. Create the WorkIt project entry at the OpenSSF Best Practices site.
2. Fill in the public repository URL: `https://github.com/WorkRuntime/workit`.
3. Link the security policy: `SECURITY.md`.
4. Link the license: `LICENSE`.
5. Link the CI workflow and verification commands.
6. Link the CodeQL workflow after the first successful run.
7. Link the release provenance workflow and the latest GitHub release.
8. Record any checklist items that are intentionally deferred.
9. Add the badge to `README.md` only after the badge URL exists.

## Deferred Items

These checks require project maturity or a deliberate future feature:

- broader contributor diversity
- long-term maintenance age
- recognized fuzzing integration
- external security review

Do not fake these items. Track them as roadmap work until real evidence exists.
