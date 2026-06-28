/**
 * Release evidence: real SQLite receipt ledger integration.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReceipt } from "../../../dist/replay/index.js";
import {
  ReceiptLedgerConflictError,
  createSqliteReceiptLedger,
} from "../../../dist/ledger/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("release");

await suite.proof(
  "REL-007",
  "SQLite receipt ledger persists through a real file-backed database",
  "a receipt appended through node:sqlite is readable after database close and reopen, while conflicting content is rejected",
  async () => {
    const sqlite = await loadNodeSqlite();
    if (sqlite === null) {
      return {
        ok: true,
        mode: "skipped_node_sqlite_unavailable",
        limitation: "Real SQLite integration runs when node:sqlite is present in the active Node runtime.",
      };
    }

    const temp = await mkdtemp(join(tmpdir(), "workit-sqlite-ledger-"));
    const dbPath = join(temp, "receipts.sqlite");
    try {
      const receipt = makeReceipt("sqlite-integration", 1);
      const conflict = makeReceipt("sqlite-integration", 2);
      const firstClient = createNodeSqliteReceiptClient(new sqlite.DatabaseSync(dbPath));
      const firstLedger = createSqliteReceiptLedger({ db: firstClient, clock: () => 10 });
      const firstRecord = await firstLedger.append(receipt);
      firstClient.close();

      const secondClient = createNodeSqliteReceiptClient(new sqlite.DatabaseSync(dbPath));
      const secondLedger = createSqliteReceiptLedger({ db: secondClient, clock: () => 20 });
      const restored = await secondLedger.get("sqlite-integration");
      const secondRecord = await secondLedger.append(receipt);
      const conflictRejected = await catchesConflict(secondLedger.append(conflict));
      const listed = await secondLedger.list();
      secondClient.close();

      return {
        ok: restored?.receiptId === receipt.receiptId
          && firstRecord.checksum === secondRecord.checksum
          && listed.length === 1
          && listed[0]?.receiptId === receipt.receiptId
          && conflictRejected,
        mode: "real_node_sqlite",
        dbPath: "temporary-file",
        restoredOutcome: restored?.terminal.outcome,
        firstRecord,
        secondRecord,
        conflictRejected,
        postgres: {
          mode: "gated_by_external_database",
          env: "WORKIT_POSTGRES_INTEGRATION_URL",
          limitation: "Postgres integration remains a separate environment-gated check because this package has no runtime pg dependency.",
        },
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

async function loadNodeSqlite() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (text.includes("SQLite is an experimental feature")) return;
    return originalEmitWarning.call(process, warning, ...args);
  };
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function createNodeSqliteReceiptClient(db) {
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    close() {
      db.close();
    },
  };
}

function makeReceipt(receiptId, completedCount) {
  return buildReceipt([], {
    id: `scope-${receiptId}`,
    status: "closed",
    startedAt: 1,
    pendingCount: 0,
    completedCount,
    failedCount: 0,
    cancelledCount: 0,
    tasks: [],
    scopes: [],
  }, {
    clock: () => 2,
    receiptId,
  });
}

async function catchesConflict(promise) {
  try {
    await promise;
    return false;
  } catch (error) {
    return error instanceof ReceiptLedgerConflictError;
  }
}
