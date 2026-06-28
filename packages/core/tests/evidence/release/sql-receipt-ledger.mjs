/**
 * Release evidence: SQL receipt ledger port adapters.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createSuite } from "../harness.mjs";
import { buildReceipt } from "../../../dist/replay/index.js";
import {
  ReceiptLedgerConflictError,
  createPostgresReceiptLedger,
  createSqliteReceiptLedger,
} from "../../../dist/ledger/index.js";

const suite = createSuite("release");

await suite.proof(
  "REL-006",
  "SQL receipt ledger adapters preserve idempotency and conflict detection",
  "SQLite and Postgres ledger ports return the same record for identical appends and reject conflicting receipt content",
  async () => {
    const sqlite = createSqliteReceiptLedger({ db: createSqliteEvidenceClient(), clock: () => 10 });
    const postgres = createPostgresReceiptLedger({ db: createPostgresEvidenceClient(), clock: () => 10 });
    const receipt = makeReceipt("sql-ledger", 1);
    const conflict = makeReceipt("sql-ledger", 2);

    const sqliteFirst = await sqlite.append(receipt);
    const sqliteSecond = await sqlite.append(receipt);
    const postgresFirst = await postgres.append(receipt);
    const postgresSecond = await postgres.append(receipt);
    const sqliteConflict = await catchesConflict(sqlite.append(conflict));
    const postgresConflict = await catchesConflict(postgres.append(conflict));

    return {
      ok: sqliteFirst.checksum === sqliteSecond.checksum
        && postgresFirst.checksum === postgresSecond.checksum
        && sqliteConflict
        && postgresConflict
        && (await sqlite.get("sql-ledger"))?.terminal.outcome === "completed"
        && (await postgres.get("sql-ledger"))?.terminal.outcome === "completed",
      sqliteRecord: sqliteFirst,
      postgresRecord: postgresFirst,
      sqliteConflict,
      postgresConflict,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

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

function createSqliteEvidenceClient() {
  const rows = new Map();
  return {
    async exec() {},
    async run(sql, params = []) {
      if (!sql.includes("INSERT OR IGNORE")) return;
      const [receiptId, checksum, createdAt, storedAt, receiptJson] = params;
      if (!rows.has(receiptId)) {
        rows.set(receiptId, {
          receipt_id: receiptId,
          checksum,
          created_at: createdAt,
          stored_at: storedAt,
          receipt_json: receiptJson,
        });
      }
    },
    async get(_sql, params = []) {
      return rows.get(params[0]);
    },
    async all() {
      return [...rows.values()];
    },
  };
}

function createPostgresEvidenceClient() {
  const rows = new Map();
  return {
    async query(sql, params = []) {
      if (sql.includes("INSERT INTO")) {
        const [receiptId, checksum, createdAt, storedAt, receiptJson] = params;
        if (!rows.has(receiptId)) {
          const row = {
            receipt_id: receiptId,
            checksum,
            created_at: createdAt,
            stored_at: storedAt,
            receipt_json: JSON.parse(receiptJson),
          };
          rows.set(receiptId, row);
          return { rows: [row] };
        }
        return { rows: [] };
      }
      if (sql.includes("WHERE receipt_id")) return { rows: [rows.get(params[0])].filter(Boolean) };
      return { rows: [...rows.values()] };
    },
  };
}
