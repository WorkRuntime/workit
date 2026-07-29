<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# A Receipt For Async Work

An async operation can return successfully while leaving an awkward question
behind: what actually happened inside it?

For a small function, the return value may be enough. For a provider call with
retries, cancellation and cleanup, it is not. Operators need to know which
attempts ran, why the operation stopped, whether cleanup timed out and whether
owned work remained pending.

WorkIt receipts preserve those lifecycle facts as data.

```ts
import { run } from "@workit/core";
import { createReceiptRecorder } from "@workit/core/replay";

// Application-owned provider boundary.
declare function callProvider(ctx: {
  signal: AbortSignal;
}): Promise<{ answer: string }>;

let observedScope;
let recorder;

await run.scope(async (scope) => {
  observedScope = scope;
  recorder = createReceiptRecorder(scope, {
    receiptId: "answer:request-42",
  });

  await scope.spawn(run.retry(callProvider, {
    times: 3,
    initialDelay: "100ms",
  }), {
    name: "provider.answer",
    kind: "llm",
  });
});

const receipt = recorder.build(observedScope.status());
recorder.unsubscribe();
```

The receipt includes the terminal outcome, normalized lifecycle events, a final
scope snapshot and a summary of cleanup or leaked-task evidence. In WorkIt
0.5.0 it can also derive one record for every retry attempt admitted by the
outer task boundary.

## Evidence, not deterministic replay

The word “replay” is overloaded. Deterministic replay records enough scheduling
and nondeterministic input to execute a program again with the same decisions.
That requires control over clocks, random values, I/O, scheduling and usually
the runtime itself.

WorkIt does something narrower. It records what the scope observed:

```txt
typed task and scope events
final scope snapshot
terminal outcome
cancellation reason
cleanup failures and timeouts
retry attempt outcomes
telemetry drop and truncation counts
```

You can store and inspect that evidence later. You cannot use it to rerun an
arbitrary JavaScript program. The distinction is useful because it keeps the
receipt contract small enough to verify.

## Attempts belong to the task lifecycle

Before 0.5.0, receipts could include retrying events. Those events explained
that another attempt was planned, but they did not provide a terminal outcome
for every invocation.

The `task:attempt` event closes that gap:

```ts
scope.onEvent((event) => {
  if (event.type !== "task:attempt") return;

  process.stdout.write(JSON.stringify({
    taskId: event.taskId,
    attempt: event.attempt,
    outcome: event.outcome,
    durationMs: event.durationMs,
  }) + "\n");
});
```

An attempt ends as `succeeded`, `failed` or `cancelled`. Nested retry wrappers
do not produce competing generic histories for the same task. The outer retry
boundary owns the task-level attempt sequence, while an application can add
more specific provider or activity evidence when it needs it.

That ownership rule prevents a receipt from presenting two incompatible
answers to “how many task attempts ran?”

## Add metadata at the boundary that knows it

The runtime knows the task id, attempt number, timing and outcome. It does not
know whether a particular invocation targeted a primary provider, a regional
replica or a billing-sensitive activity.

`createAttemptRecorder()` lets the caller add that context explicitly:

```ts
import { createAttemptRecorder } from "@workit/core/replay";

const attemptRecorder = createAttemptRecorder({
  maxAttempts: 20,
  maxMetadataBytes: 1_024,
});

// `callProvider` is the application-owned provider function from the previous
// example.
const callPrimary = attemptRecorder.wrap(callProvider, {
  metadata: {
    provider: "primary",
    operation: "answer",
  },
  reasonCode: (error) =>
    error instanceof TypeError ? "transport_error" : "provider_error",
});

const operation = run.retry(callPrimary, {
  times: 3,
  initialDelay: "100ms",
});
```

Reason codes must be bounded slugs. Metadata must be a JSON object and must fit
the configured byte limit. Common secret fields are redacted before the record
is retained.

This is deliberately caller-owned enrichment. Inferring provider policy from an
arbitrary error object would turn a lifecycle recorder into a second routing
engine.

## Redaction belongs before storage

Progress data is often valuable during an incident, although it may contain
fields that should never reach a durable ledger.

Receipt redaction has conservative defaults for common secret names, and the
caller can add its own policy:

```ts
import { redactReceipt } from "@workit/core/replay";

const publicReceipt = redactReceipt(receipt, {
  removeFields: ["privateNote"],
  redactFields: ["authorization", "tenantToken"],
});
```

Redaction is not a substitute for data minimization. The safest private payload
is still the one that was never attached to an event. It does, however, provide
a clear boundary between local lifecycle evidence and a receipt intended for
storage or publication.

## What a receipt can establish

A captured receipt can support claims about the WorkIt lifecycle it observed:

- the scope reached a terminal state;
- no owned tasks were pending in the final snapshot;
- cancellation carried a typed reason;
- cleanup failure or timeout events were present;
- admitted retry invocations had terminal outcomes;
- event truncation or telemetry drops were counted.

It cannot establish that a remote provider stopped billing, that an external
transaction was semantically correct or that an uncaptured event occurred.

Those limitations are not footnotes. They define where runtime evidence ends
and application or provider evidence begins.

## Executable evidence

The relevant release proofs are:

```txt
LIFE-004 completed scope receipt
LIFE-005 typed cancellation reason
LIFE-012 admitted attempt evidence and default secret redaction
```

They run through:

```sh
npm run test:evidence
npm run test:coverage
npm run verify
```

The tests cover completed and cancelled receipts, cleanup evidence, bounded
event windows, redaction, attempt outcomes, metadata limits and installed
package consumers.

The practical result is modest but important: when WorkIt owns an async
lifecycle, it can leave behind a typed account of what it observed.

## Sources

- [`@workit/core/replay`](../packages/core/src/replay/index.ts)
- [`replay-receipts.mjs`](../packages/core/tests/evidence/lifecycle/replay-receipts.mjs)
- [`claims.json`](../packages/core/evidence/claims.json)
