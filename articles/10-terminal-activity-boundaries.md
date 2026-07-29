<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# A Terminal Activity Boundary After Restart

A process uploads a batch and crashes after chunk 417 completes. When the job
starts again, it must decide whether chunk 417 should run.

Running it twice may duplicate a side effect. Skipping it without durable
evidence is not much better.

An activity boundary gives the operation an explicit identity, hashes its input
and stores its terminal result:

```ts
import { run } from "@workit/core";
import {
  createFileActivityStore,
  runActivity,
} from "@workit/core/activity";

const store = createFileActivityStore({
  dir: ".workit-activities",
});

// Application-owned provider boundary. The provider idempotency key remains
// separate from WorkIt's local activity record.
declare function uploadToProvider(
  chunk: number,
  opts: { signal: AbortSignal; idempotencyKey: string },
): Promise<{ etag: string }>;

const uploadChunk = runActivity(
  store,
  {
    activityId: "upload:batch-42:chunk-417",
    input: {
      batchId: "batch-42",
      chunk: 417,
      checksum: "6d7fce9f",
    },
    name: "upload chunk 417",
    version: "v1",
  },
  async (ctx) => {
    return uploadToProvider(417, {
      signal: ctx.signal,
      idempotencyKey: "batch-42:chunk-417",
    });
  },
);

const result = await run.scope(async (scope) => {
  return scope.spawn(uploadChunk);
});
```

After completion, a new process using the same store can submit the same
activity id and input. WorkIt returns the stored result without invoking the
body again.

That is terminal activity replay. It is not transparent workflow replay.

## The application chooses the durable boundary

WorkIt does not persist arbitrary closures, JavaScript stacks or scheduler
state. The caller decides which segment has a durable identity.

The activity contract records:

```txt
activity id
activity version
canonical input hash
started timestamp
terminal status
result or bounded error evidence
typed cancellation reason when applicable
```

This explicit boundary is useful because external side effects rarely have
universal retry semantics. Uploading a chunk, charging a card and sending an
email need different idempotency and repair policies.

## The same id with different input is a conflict

An activity id cannot safely mean two things.

```ts
import {
  ActivityConflictError,
  createMemoryActivityStore,
  runActivity,
} from "@workit/core/activity";

const memoryStore = createMemoryActivityStore();

const first = runActivity(
  memoryStore,
  { activityId: "export:42", input: { page: 1 } },
  async () => "page one",
);

await run.scope((scope) => scope.spawn(first));

const changed = runActivity(
  memoryStore,
  { activityId: "export:42", input: { page: 2 } },
  async () => "page two",
);

try {
  await run.scope((scope) => scope.spawn(changed));
} catch (error) {
  if (!(error instanceof ActivityConflictError)) throw error;
}
```

The second body does not run. WorkIt compares canonical input hashes and fails
at the boundary.

Inputs that cannot produce a stable JSON representation are rejected. This
includes cyclic objects, functions, symbols, `bigint`, non-finite numbers and
`undefined`.

## Completed records replay; uncertain records do not

An activity record can be started, completed, failed or cancelled. Only a
completed record returns its stored result on a later invocation.

Started, failed and cancelled records fail closed. WorkIt does not silently
rerun them because their external effects may be uncertain. A provider could
have accepted a request just before the process stopped, or a cancellation
could have arrived after a remote commit.

The application can inspect the record and choose a repair policy. That may
mean querying the provider by an idempotency key, compensating a partial effect
or authorizing a new activity id.

The runtime preserves evidence instead of guessing.

## What restart evidence proves

The release evidence runs the activity, discards the first store instance and
opens a fresh file-store instance over the same directory. A second execution
receives the saved result while the activity body remains at one invocation.

This proves persistence across a store-shaped restart after a completed
terminal write. The current evidence does not claim multi-process coordination,
recovery after process termination or recovery of arbitrary in-flight work.

## The application still owns external correctness

Activity records do not replace provider idempotency keys, database
transactions, distributed locks or compensation logic.

The reliable composition is:

```txt
application chooses activity identity
provider receives its own idempotency key
WorkIt records terminal activity evidence
restart reuses completed evidence
uncertain states go through an explicit repair policy
```

This division keeps local lifecycle ownership separate from remote side-effect
authority.

## Executable evidence

The relevant proofs are:

```txt
CORR-012 explicit activity boundary and conflict detection
LIFE-008 file activity store restart replay
```

Run them with:

```sh
npm run test:evidence
npm run test:coverage
npm run verify
```

The unit suite also covers input canonicalization, corrupt records, safe file
names, terminal error evidence and cancellation reason persistence.

The useful promise is intentionally bounded: for an explicit activity id and
matching input, WorkIt can reuse a completed terminal result after restart.

## Sources

- [`@workit/core/activity`](../packages/core/src/activity/index.ts)
- [`activity-boundary.mjs`](../packages/core/tests/evidence/correctness/activity-boundary.mjs)
- [`activity-restart.mjs`](../packages/core/tests/evidence/lifecycle/activity-restart.mjs)
- [`claims.json`](../packages/core/evidence/claims.json)
