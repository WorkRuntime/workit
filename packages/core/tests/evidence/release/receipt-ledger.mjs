/**
 * Release evidence: receipt ledger idempotency and file persistence.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileReceiptLedger } from "../../../dist/ledger/index.js";
import { buildReceipt } from "../../../dist/replay/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("release");

await suite.proof(
  "REL-004",
  "file receipt ledger persists append-only receipt evidence",
  "a receipt appended by one ledger instance is readable from a new ledger instance",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "workit-evidence-ledger-"));
    try {
      const receipt = buildReceipt([], {
        id: "scope-ledger",
        status: "closed",
        startedAt: 1,
        pendingCount: 0,
        completedCount: 1,
        failedCount: 0,
        cancelledCount: 0,
        tasks: [],
        scopes: [],
      }, {
        clock: () => 2,
        receiptId: "receipt-ledger",
      });

      const first = createFileReceiptLedger({ dir, clock: () => 3 });
      const record = await first.append(receipt);
      const second = createFileReceiptLedger({ dir });
      const restored = await second.get("receipt-ledger");

      return {
        ok: restored?.receiptId === "receipt-ledger" && record.receiptId === "receipt-ledger",
        record,
        restoredOutcome: restored?.terminal.outcome,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
