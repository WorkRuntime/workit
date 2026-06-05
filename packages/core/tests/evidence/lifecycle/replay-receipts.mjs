/**
 * Lifecycle evidence: replayable receipts over existing WorkIt events.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { CancellationError, run } from "../../../dist/index.js";
import { createReceiptRecorder } from "../../../dist/replay/index.js";
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

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
