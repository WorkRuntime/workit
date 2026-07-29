<!--
Author: Admilson B. F. Cossa
SPDX-License-Identifier: Apache-2.0
-->

# Plan Retries Before They Run

A retry policy can look reasonable on its own and still be impossible inside
the request that owns it.

Suppose one provider attempt may take 800 milliseconds. The call allows four
attempts with increasing backoff, while the request has two seconds left. The
individual numbers are valid, yet the composition cannot fit.

`@workit/core/time-policy` evaluates that shape before task execution:

```ts
import { planTimePolicy } from "@workit/core/time-policy";

const plan = planTimePolicy({
  type: "timeout",
  timeout: "2s",
  policy: {
    type: "retry",
    attempt: {
      type: "attempt",
      duration: "800ms",
    },
    retry: {
      times: 4,
      initialDelay: "100ms",
      factor: 2,
      jitter: false,
    },
  },
});

if (!plan.valid) {
  console.error(plan.warnings);
}
```

The planner does not call the provider. It computes a conservative upper bound
from the declared policy and reports typed warnings when the composition cannot
fit.

## Runtime policy and planning policy have different jobs

`run.retry()` owns execution. It invokes the task, observes cancellation,
sleeps with the task signal and decides whether another attempt may start.

`planTimePolicy()` owns pre-execution analysis. It works with declared attempt
costs and composition rules:

```txt
attempt
retry
hedge
timeout
deadline
series
parallel
```

Keeping those responsibilities separate matters. A planner should not produce
side effects, while a runtime should not pretend it can predict provider
latency that the caller never declared.

## A deadline is part of the task context

WorkIt 0.5.0 exposes the earliest effective absolute deadline as
`ctx.deadlineAt`.

```ts
import { run } from "@workit/core";

const deadlineAt = Date.now() + 2_000;

const result = await run.group(async (task) => {
  return task(run.deadline(async (ctx) => {
    return {
      deadlineAt: ctx.deadlineAt,
      remainingMs: Math.max(0, ctx.deadlineAt! - Date.now()),
    };
  }, deadlineAt));
});
```

If a task has both an inherited scope deadline and a wrapper deadline, it sees
the earlier value. Retry, fallback and hedge compositions preserve that
effective deadline for their task bodies.

The value is introspection, not preemption. The task must still cooperate with
`ctx.signal`, and external I/O must receive that signal when the client supports
abort.

## A retry count is not a shared admission policy

Per-operation retry limits prevent one wrapper from running forever. They do
not stop several sibling operations from consuming too many retries together.

Version 0.5.0 adds a shared retry budget:

```ts
import { createBudget, run } from "@workit/core";

const ProviderRetries = createBudget("ProviderRetries", {
  unit: "retries",
});

// Application-owned provider boundary.
declare function callProvider(ctx: {
  signal: AbortSignal;
}): Promise<{ answer: string }>;

const operation = run.retry(callProvider, {
  times: 4,
  initialDelay: "100ms",
  retryBudget: ProviderRetries,
});

const result = await run.context.with(
  ProviderRetries,
  { spent: 0, limit: 5, unit: "retries" },
  async () => run.group(async (task) => {
    const first = task(operation);
    const second = task(operation);
    return Promise.all([first, second]);
  }),
);
```

The initial invocation is not a retry, so it is not charged. Before each
additional attempt is admitted, the wrapper atomically consumes one unit from
the scope-visible budget. When the budget is exhausted, the next retry body
does not start.

This turns “three retries per call” into a policy that can also say “no more
than five additional provider invocations across this request.”

## Check aggregate retry demand

The planner can evaluate that shared policy when the caller supplies a runtime
snapshot:

```ts
import {
  planTimePolicy,
  type RetryBudgetSnapshot,
} from "@workit/core/time-policy";

const retryBudgets: RetryBudgetSnapshot[] = [{
  key: ProviderRetries,
  state: {
    spent: 1,
    limit: 5,
    unit: "retries",
  },
}];

const providerPolicy = {
  type: "retry" as const,
  attempt: {
    type: "attempt" as const,
    duration: "800ms" as const,
  },
  retry: {
    times: 3,
    initialDelay: "100ms" as const,
    retryBudget: ProviderRetries,
  },
};

const plan = planTimePolicy({
  type: "parallel",
  policies: [
    providerPolicy,
    providerPolicy,
  ],
}, {
  retryBudgets,
});
```

For every referenced budget, the result reports required retries, remaining
capacity and one of three statuses:

```txt
admissible
exceeded
unverified
```

An absent snapshot produces `retry_budget_snapshot_missing`. Insufficient
capacity produces `retry_budget_exceeded`. Both make the plan invalid because
the declared composition cannot be admitted from the supplied state.

## What the upper bound means

For fixed retry delays, the planner includes attempt duration and the waits
between failed attempts. For parallel policies it distinguishes critical-path
time from aggregate parallel work. Timeout and deadline nodes can truncate the
outer bound while retaining a warning that inner work exceeds it.

Jitter, dynamic backoff, event-loop stalls and provider latency add uncertainty.
The planner reports its bounded contract instead of presenting the result as an
exact wall-clock forecast.

## Executable evidence

The release connects these claims to:

```txt
CORR-009 retry upper bounds
CORR-010 infeasible deadline warning
CORR-016 bounded time-policy cost model
CORR-021 nested composition model
CORR-024 effective runtime deadline
CORR-025 shared retry admission budget
CORR-027 aggregate retry budget planning
```

Run the proofs with:

```sh
npm run test:evidence
npm run test:coverage
npm run verify
```

The bounded model currently checks 640 generated policies, while the nested
composition evidence checks 1,516 generated policy trees. These are executable
finite models, not theorems over arbitrary TypeScript or real provider timing.

Planning does not remove runtime uncertainty. It catches policies that are
already impossible before that uncertainty begins.

## Sources

- [`@workit/core/time-policy`](../packages/core/src/time-policy/index.ts)
- [`time-policy-planner.mjs`](../packages/core/tests/evidence/correctness/time-policy-planner.mjs)
- [`runtime-contracts.mjs`](../packages/core/tests/evidence/correctness/runtime-contracts.mjs)
- [`claims.json`](../packages/core/evidence/claims.json)
