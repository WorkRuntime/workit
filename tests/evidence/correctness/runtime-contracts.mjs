/**
 * Correctness evidence: budgets, channels, diagnostics, and retry policy.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createChannel } from "../../../dist/channel/index.js";
import { diagnoseSnapshot } from "../../../dist/diagnostics/index.js";
import { CostBudget, run } from "../../../dist/index.js";
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

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
