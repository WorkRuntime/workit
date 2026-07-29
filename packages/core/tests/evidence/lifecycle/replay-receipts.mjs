/**
 * Lifecycle evidence: replayable receipts over existing WorkIt events.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { CancellationError, run } from "../../../dist/index.js";
import { createAttemptRecorder, createReceiptRecorder } from "../../../dist/replay/index.js";
import { createSuite, sleep } from "../harness.mjs";

const suite = createSuite("lifecycle");

await suite.proof(
  "LIFE-004",
  "replay receipts record completed scope closure",
  "a closed successful scope has completed terminal outcome and no leaked tasks",
  async () => {
    let scopeRef;
    let recorder;

    await run.scope(async (scope) => {
      scopeRef = scope;
      recorder = createReceiptRecorder(scope, { receiptId: "evidence-completed" });
      await scope.spawn(async () => "ok", { name: "receipt.evidence" });
    }, { name: "receipt-evidence-root" });

    const receipt = recorder.build(scopeRef.status());

    return {
      ok: receipt.terminal.outcome === "completed"
        && receipt.summary.leakedTasks === 0
        && receipt.events.some((event) => event.type === "scope:closed"),
      outcome: receipt.terminal.outcome,
      leakedTasks: receipt.summary.leakedTasks,
      eventCount: receipt.events.length,
    };
  },
);

await suite.proof(
  "LIFE-005",
  "replay receipts preserve typed cancellation reason",
  "a manually cancelled scope records the cancellation reason observed by owned work",
  async () => {
    let scopeRef;
    let recorder;
    let error;

    try {
      await run.scope(async (scope) => {
        scopeRef = scope;
        recorder = createReceiptRecorder(scope, { receiptId: "evidence-cancelled" });
        const handle = scope.spawn(async (ctx) => {
          await sleep(1_000, ctx.signal);
        }, { name: "receipt.cancelled" });
        scope.cancel({ kind: "manual", tag: "receipt_evidence" });
        await handle;
      }, { name: "receipt-cancel-root" });
    } catch (caught) {
      error = caught;
    }

    const receipt = recorder.build(scopeRef.status());

    return {
      ok: error instanceof CancellationError
        && receipt.terminal.outcome === "cancelled"
        && receipt.terminal.cancelReason?.kind === "manual"
        && receipt.terminal.cancelReason.tag === "receipt_evidence",
      errorClass: error?.constructor?.name,
      outcome: receipt.terminal.outcome,
      cancelReason: receipt.terminal.cancelReason,
    };
  },
);

await suite.proof(
  "LIFE-012",
  "attempt evidence records actual retry invocations",
  "each admitted retry invocation records its attempt number, bounded reason code, outcome, and redacted metadata",
  async () => {
    const recorder = createAttemptRecorder();
    let calls = 0;

    await run.group(async (task) => task(run.retry(recorder.wrap(async () => {
      calls++;
      if (calls === 1) throw new Error("provider unavailable");
      return "ok";
    }, {
      metadata: { provider: "primary", token: "secret" },
      reasonCode: () => "provider_unavailable",
    }), { times: 2, initialDelay: 0 })));

    const attempts = recorder.attempts;
    return {
      ok: attempts.length === 2
        && attempts[0]?.attempt === 1
        && attempts[0]?.outcome === "failed"
        && attempts[0]?.reasonCode === "provider_unavailable"
        && attempts[0]?.metadata?.token === "[redacted]"
        && attempts[1]?.attempt === 2
        && attempts[1]?.outcome === "succeeded",
      attempts,
      droppedAttempts: recorder.droppedAttempts,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
