/**
 * Correctness evidence: budgets, channels, diagnostics, and retry policy.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createChannel } from "../../../dist/channel/index.js";
import { diagnoseSnapshot } from "../../../dist/diagnostics/index.js";
import {
  BudgetExceededError,
  CancellationError,
  CostBudget,
  createBudget,
  run,
} from "../../../dist/index.js";
import { createReceiptRecorder } from "../../../dist/replay/index.js";
import { assert, createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-001",
  "budget input is immutable and runtime budget is explicit",
  "caller input object is not mutated; final spent value is read from run.context.budget",
  async () => {
    const input = { spent: 0, limit: 100, unit: "credits" };
    let finalBudget;

    await run.context.with(CostBudget, input, async () => {
      await run.scope(async (scope) => {
        await Promise.all([
          scope.spawn((ctx) => {
            ctx.consume(CostBudget, 25);
            return "a";
          }),
          scope.spawn((ctx) => {
            ctx.consume(CostBudget, 25);
            return "b";
          }),
        ]);
      });
      finalBudget = run.context.budget(CostBudget);
    });

    return {
      ok: input.spent === 0 && finalBudget?.spent === 50,
      input,
      finalBudget,
    };
  },
);

await suite.proof(
  "CORR-002",
  "channel capacity applies producer backpressure",
  "third send to capacity-two channel blocks until a receive drains one item",
  async () => {
    const channel = createChannel({ capacity: 2 });
    await channel.send("a");
    await channel.send("b");

    let thirdSettled = false;
    const third = channel.send("c").then(() => {
      thirdSettled = true;
    });
    await Promise.resolve();
    const blockedBeforeReceive = thirdSettled === false;
    const first = await channel.receive();
    await third;

    return {
      ok: blockedBeforeReceive && first?.value === "a" && thirdSettled,
      blockedBeforeReceive,
      first,
      thirdSettled,
    };
  },
);

await suite.proof(
  "CORR-003",
  "diagnostics report stable finding codes",
  "cleanup timeout events produce cleanup_timeout findings",
  async () => {
    const report = diagnoseSnapshot({
      id: "scope-evidence",
      name: "evidence",
      status: "closing",
      startedAt: 1_000,
      pendingCount: 0,
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      tasks: [],
      scopes: [],
    }, {
      now: 2_000,
      events: [
        { type: "task:cleanup_timeout", taskId: "task-a", timeoutMs: 25, at: Date.now() },
      ],
    });
    const codes = report.findings.map((finding) => finding.code);

    return {
      ok: report.status === "needs_attention" && codes.includes("cleanup_timeout"),
      status: report.status,
      codes,
    };
  },
);

await suite.proof(
  "CORR-004",
  "retry policy rejects unsafe attempt counts",
  "unbounded retry counts are rejected at the policy boundary",
  async () => {
    let error;
    try {
      run.retry(async () => "never", { times: 1_000_000 });
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof RangeError, "unsafe retry count must throw RangeError");

    return {
      ok: /between 1 and 1000/.test(error.message),
      errorClass: error.constructor.name,
      message: error.message,
    };
  },
);

await suite.proof(
  "CORR-024",
  "task context exposes the effective composed deadline",
  "nested retry and fallback attempts observe the absolute deadline declared by the owning wrapper",
  async () => {
    const deadlineAt = Date.now() + 2_000;
    const observed = [];
    let attempts = 0;

    await run.group(async (task) => task(run.deadline(run.retry(run.fallback(
      async (ctx) => {
        observed.push(ctx.deadlineAt);
        attempts++;
        throw new Error("primary unavailable");
      },
      async (ctx) => {
        observed.push(ctx.deadlineAt);
        if (attempts === 1) throw new Error("retry fallback");
        return "ok";
      },
    ), { times: 2, initialDelay: 0 }), deadlineAt)));

    return {
      ok: observed.length === 4 && observed.every((value) => value === deadlineAt),
      deadlineAt,
      observed,
    };
  },
);

await suite.proof(
  "CORR-025",
  "shared retry budget blocks excess attempts before execution",
  "two retry wrappers share one scope budget and the exhausted wrapper does not start its retry body",
  async () => {
    const RetryBudget = createBudget("EvidenceRetryBudget", { unit: "retries" });
    let firstAttempts = 0;
    let secondAttempts = 0;
    let error;

    try {
      await run.context.with(RetryBudget, { limit: 1, spent: 0, unit: "retries" }, async () => {
        await run.group(async (task) => {
          await task(run.retry(async () => {
            firstAttempts++;
            if (firstAttempts === 1) throw new Error("first retry");
            return "ok";
          }, { times: 2, initialDelay: 0, retryBudget: RetryBudget }));

          await task(run.retry(async () => {
            secondAttempts++;
            throw new Error("second retry");
          }, { times: 2, initialDelay: 0, retryBudget: RetryBudget }));
        });
      });
    } catch (caught) {
      error = caught;
    }

    return {
      ok: error instanceof BudgetExceededError
        && firstAttempts === 2
        && secondAttempts === 1,
      errorClass: error?.constructor?.name,
      firstAttempts,
      secondAttempts,
    };
  },
);

await suite.proof(
  "CORR-026",
  "deadline retry fallback cancellation and receipt evidence compose",
  "one cancelled retry composition preserves its effective deadline and records failed and cancelled attempts in the terminal receipt",
  async () => {
    const RetryBudget = createBudget("ComposedRetryBudget", { unit: "retries" });
    const deadlineAt = Date.now() + 2_000;
    const observedDeadlines = [];
    let scopeRef;
    let recorder;
    let releaseSecondAttempt;
    const secondAttemptStarted = new Promise((resolve) => {
      releaseSecondAttempt = resolve;
    });
    let error;

    try {
      await run.context.with(RetryBudget, { limit: 1, spent: 0, unit: "retries" }, () =>
        run.scope(async (scope) => {
          scopeRef = scope;
          recorder = createReceiptRecorder(scope, { receiptId: "composed-runtime-contract" });
          const handle = scope.spawn(run.deadline(run.retry(run.fallback(
            async (ctx) => {
              observedDeadlines.push(ctx.deadlineAt);
              if (ctx.attempt === 1) throw new Error("primary unavailable");
              releaseSecondAttempt();
              await waitForAbort(ctx.signal);
              return "unreachable";
            },
            async (ctx) => {
              observedDeadlines.push(ctx.deadlineAt);
              throw new Error("fallback unavailable");
            },
          ), {
            times: 3,
            initialDelay: 0,
            retryBudget: RetryBudget,
          }), deadlineAt), { name: "composed-runtime-contract" });

          await secondAttemptStarted;
          scope.cancel({ kind: "manual", tag: "composed_stop" });
          await handle;
        }, { name: "composed-runtime-contract" })
      );
    } catch (caught) {
      error = caught;
    }

    const receipt = recorder.build(scopeRef.status());
    recorder.unsubscribe();
    const attempts = receipt.attempts ?? [];

    return {
      ok: error instanceof CancellationError
        && receipt.terminal.outcome === "cancelled"
        && receipt.terminal.cancelReason?.kind === "manual"
        && receipt.terminal.cancelReason.tag === "composed_stop"
        && observedDeadlines.length === 3
        && observedDeadlines.every((value) => value === deadlineAt)
        && attempts.length === 2
        && attempts[0]?.outcome === "failed"
        && attempts[1]?.outcome === "cancelled",
      errorClass: error?.constructor?.name,
      terminal: receipt.terminal,
      observedDeadlines,
      attempts: attempts.map(({ attempt, outcome }) => ({ attempt, outcome })),
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
