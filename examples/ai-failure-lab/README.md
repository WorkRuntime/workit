# WorkIt AI Failure Lab

This standalone Node.js project runs the same bounded incident datasets shown by
the WorkIt examples site through the published `@workit/core@0.6.1` package.

## Run locally

```bash
npm ci --no-audit --no-fund
npm test
npm start
```

Edit `scenarios/grounded-fallback.json`, then run the command again. Other
tracked paths are available through `npm run run:approval` and
`npm run run:deadline`.

The browser site labels its immediate result as a policy preview. This project
is the real Node.js execution path: scenario contract, WorkIt candidate runtime,
shared retry budget, global deadline, bounded evidence, and human-authority
stop.

## Run in GitHub Codespaces

The public launch target uses the checked-in dev container. It opens the
laboratory as the workspace, installs the lockfile, runs the full laboratory
test suite, and then executes the grounded-fallback scenario.

Browser WebContainers are not treated as execution authority for this example.
WorkIt's shared budget ownership depends on Node async-context semantics, so the
one-click runtime uses a real Linux Node environment rather than weakening the
scenario for a browser emulator.

## Trust boundary

- The project accepts only the versioned fields in `contract/scenario-contract.mjs`.
- Candidate count, attempts, strings, evidence, latency, retries, bytes, and
  deadline are bounded.
- Unknown fields are rejected; do not put credentials in a scenario.
- Providers are deterministic local fixtures. No external provider is contacted.
- Public-data imports in the website create bounded datasets; they do not grant
  arbitrary network or code execution.

## License

Apache-2.0. Author: Admilson B. F. Cossa.
