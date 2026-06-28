/**
 * Receipt ledger subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceipt } from "../../dist/replay/index.js";
import {
  ReceiptLedgerConflictError,
  createFileReceiptLedger,
  createMemoryReceiptLedger,
  createPostgresReceiptLedger,
  createSqliteReceiptLedger,
} from "../../dist/ledger/index.js";

function makeReceipt(receiptId, completedCount = 1) {
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

test("Given memory ledger, append is idempotent for identical receipt content", async () => {
  const ledger = createMemoryReceiptLedger();
  const receipt = makeReceipt("receipt-memory");

  const first = await ledger.append(receipt);
  const second = await ledger.append(receipt);

  assert.equal(first.receiptId, "receipt-memory");
  assert.equal(first.checksum, second.checksum);
  assert.deepEqual(await ledger.get("receipt-memory"), receipt);
  assert.deepEqual((await ledger.list()).map((record) => record.receiptId), ["receipt-memory"]);
});

test("Given memory ledger, conflicting receipt id is rejected", async () => {
  const ledger = createMemoryReceiptLedger();
  await ledger.append(makeReceipt("receipt-conflict", 1));

  await assert.rejects(
    ledger.append(makeReceipt("receipt-conflict", 2)),
    ReceiptLedgerConflictError,
  );
});

test("Given memory ledger retention limit, oldest receipts are evicted", async () => {
  const ledger = createMemoryReceiptLedger({ maxReceipts: 1 });

  await ledger.append(makeReceipt("receipt-old"));
  await ledger.append(makeReceipt("receipt-new"));

  assert.equal(await ledger.get("receipt-old"), undefined);
  assert.equal((await ledger.list())[0].receiptId, "receipt-new");
});

test("Given same createdAt records, ledger list falls back to receipt id ordering", async () => {
  const ledger = createMemoryReceiptLedger({ clock: () => 10 });

  await ledger.append(makeReceipt("receipt-b"));
  await ledger.append(makeReceipt("receipt-a"));

  assert.deepEqual((await ledger.list()).map((record) => record.receiptId), ["receipt-a", "receipt-b"]);
});

test("Given invalid memory ledger retention, constructor rejects the contract", () => {
  assert.throws(() => createMemoryReceiptLedger({ maxReceipts: 0 }), /maxReceipts/);
});

test("Given file ledger, receipts persist across ledger instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-ledger-"));
  try {
    const receipt = makeReceipt("receipt-file");
    const firstLedger = createFileReceiptLedger({ dir });
    const firstRecord = await firstLedger.append(receipt);

    const secondLedger = createFileReceiptLedger({ dir });
    const restored = await secondLedger.get("receipt-file");
    const listed = await secondLedger.list();

    assert.equal(restored.receiptId, "receipt-file");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].checksum, firstRecord.checksum);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given file ledger existing receipt, append is idempotent and conflicts are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-ledger-existing-"));
  try {
    const ledger = createFileReceiptLedger({ dir });
    const receipt = makeReceipt("receipt-existing", 1);
    const first = await ledger.append(receipt);
    const second = await ledger.append(receipt);

    assert.equal(first.checksum, second.checksum);
    await assert.rejects(
      ledger.append(makeReceipt("receipt-existing", 2)),
      ReceiptLedgerConflictError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given file ledger directory noise and missing ids, list ignores non-json and get returns undefined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-ledger-noise-"));
  try {
    const ledger = createFileReceiptLedger({ dir });
    await writeFile(join(dir, "ignore.txt"), "ignore", "utf8");

    assert.equal(await ledger.get("missing"), undefined);
    assert.deepEqual(await ledger.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given malformed stored receipt file, file ledger surfaces parse failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workit-ledger-malformed-"));
  try {
    const ledger = createFileReceiptLedger({ dir });
    await writeFile(join(dir, `${Buffer.from("broken", "utf8").toString("base64url")}.json`), "{", "utf8");

    await assert.rejects(ledger.get("broken"), SyntaxError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Given SQLite ledger client, receipts append idempotently and list in stable order", async () => {
  const db = createSqliteTestClient();
  const ledger = createSqliteReceiptLedger({ db, clock: () => 10 });
  const receiptB = makeReceipt("receipt-sqlite-b");
  const receiptA = makeReceipt("receipt-sqlite-a");

  const first = await ledger.append(receiptB);
  const second = await ledger.append(receiptB);
  await ledger.append(receiptA);

  assert.equal(first.checksum, second.checksum);
  assert.deepEqual(await ledger.get("receipt-sqlite-b"), receiptB);
  assert.deepEqual((await ledger.list()).map((record) => record.receiptId), [
    "receipt-sqlite-a",
    "receipt-sqlite-b",
  ]);
  assert.equal(db.statements.some((statement) => statement.includes("CREATE TABLE IF NOT EXISTS")), true);
});

test("Given SQLite ledger existing receipt, conflicting content is rejected", async () => {
  const db = createSqliteTestClient();
  const ledger = createSqliteReceiptLedger({ db });

  await ledger.append(makeReceipt("receipt-sqlite-conflict", 1));

  await assert.rejects(
    ledger.append(makeReceipt("receipt-sqlite-conflict", 2)),
    ReceiptLedgerConflictError,
  );
});

test("Given SQL ledger missing ids, get returns undefined after initialization", async () => {
  const sqliteLedger = createSqliteReceiptLedger({ db: createSqliteTestClient() });
  const postgresLedger = createPostgresReceiptLedger({ db: createPostgresTestClient() });

  assert.equal(await sqliteLedger.get("missing-sqlite"), undefined);
  assert.equal(await postgresLedger.get("missing-postgres"), undefined);
});

test("Given SQL ledger insert does not persist a row, append surfaces storage failure", async () => {
  const sqliteLedger = createSqliteReceiptLedger({ db: createSqliteNoStoreClient() });
  const postgresLedger = createPostgresReceiptLedger({ db: createPostgresNoStoreClient() });

  await assert.rejects(
    sqliteLedger.append(makeReceipt("receipt-sqlite-lost-write")),
    /did not store/,
  );
  await assert.rejects(
    postgresLedger.append(makeReceipt("receipt-postgres-lost-write")),
    /did not store/,
  );
});

test("Given Postgres ledger client, receipts append idempotently and list in stable order", async () => {
  const db = createPostgresTestClient();
  const ledger = createPostgresReceiptLedger({ db, clock: () => 10 });
  const receiptB = makeReceipt("receipt-postgres-b");
  const receiptA = makeReceipt("receipt-postgres-a");

  const first = await ledger.append(receiptB);
  const second = await ledger.append(receiptB);
  await ledger.append(receiptA);

  assert.equal(first.checksum, second.checksum);
  assert.deepEqual(await ledger.get("receipt-postgres-b"), receiptB);
  assert.deepEqual((await ledger.list()).map((record) => record.receiptId), [
    "receipt-postgres-a",
    "receipt-postgres-b",
  ]);
  assert.equal(db.statements.some((statement) => statement.includes("CREATE TABLE IF NOT EXISTS")), true);
});

test("Given Postgres ledger existing receipt, conflicting content is rejected", async () => {
  const db = createPostgresTestClient();
  const ledger = createPostgresReceiptLedger({ db });

  await ledger.append(makeReceipt("receipt-postgres-conflict", 1));

  await assert.rejects(
    ledger.append(makeReceipt("receipt-postgres-conflict", 2)),
    ReceiptLedgerConflictError,
  );
});

test("Given SQL ledger rows with supported database number types, parser normalizes records", async () => {
  const receipt = makeReceipt("receipt-sql-row");
  const ledger = createSqliteReceiptLedger({
    db: createSqliteStaticRowsClient([makeSqlRow(receipt, {
      created_at: 2n,
      stored_at: "10",
      receipt_json: receipt,
    })]),
  });

  const [record] = await ledger.list();

  assert.equal(record.receiptId, "receipt-sql-row");
  assert.equal(record.createdAt, 2);
  assert.equal(record.storedAt, 10);
});

test("Given malformed SQL ledger rows, parser rejects invalid storage contracts", async () => {
  const receipt = makeReceipt("receipt-malformed-sql");

  await assert.rejects(
    createSqliteReceiptLedger({
      db: createSqliteStaticRowsClient([makeSqlRow(receipt, { receipt_id: 1 })]),
    }).list(),
    /receipt_id.*string/,
  );
  await assert.rejects(
    createSqliteReceiptLedger({
      db: createSqliteStaticRowsClient([makeSqlRow(receipt, { created_at: "not-number" })]),
    }).list(),
    /created_at.*numeric/,
  );
  await assert.rejects(
    createPostgresReceiptLedger({
      db: createPostgresStaticRowsClient([makeSqlRow(receipt, { receipt_json: 1 })]),
    }).list(),
    /receipt_json.*JSON/,
  );
});

test("Given unsafe SQL ledger table names, constructors reject before issuing SQL", () => {
  assert.throws(
    () => createSqliteReceiptLedger({ db: createSqliteTestClient(), tableName: "receipts;drop" }),
    /SQL identifier/,
  );
  assert.throws(
    () => createPostgresReceiptLedger({ db: createPostgresTestClient(), tableName: "bad-name" }),
    /SQL identifier/,
  );
});

test("Given the root import, ledger helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("createMemoryReceiptLedger" in root, false);
  assert.equal("createFileReceiptLedger" in root, false);
  assert.equal("createSqliteReceiptLedger" in root, false);
  assert.equal("createPostgresReceiptLedger" in root, false);
});

function createSqliteTestClient() {
  const rows = new Map();
  const statements = [];
  return {
    statements,
    async exec(sql) {
      statements.push(sql);
    },
    async run(sql, params = []) {
      statements.push(sql);
      if (sql.includes("INSERT OR IGNORE")) {
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
      }
    },
    async get(sql, params = []) {
      statements.push(sql);
      return rows.get(params[0]);
    },
    async all(sql) {
      statements.push(sql);
      return [...rows.values()].sort(compareSqlRows);
    },
  };
}

function createSqliteNoStoreClient() {
  const statements = [];
  return {
    statements,
    async exec(sql) {
      statements.push(sql);
    },
    async run(sql) {
      statements.push(sql);
    },
    async get(sql) {
      statements.push(sql);
      return undefined;
    },
    async all(sql) {
      statements.push(sql);
      return [];
    },
  };
}

function createSqliteStaticRowsClient(rows) {
  const statements = [];
  return {
    statements,
    async exec(sql) {
      statements.push(sql);
    },
    async run(sql) {
      statements.push(sql);
    },
    async get(sql, params = []) {
      statements.push(sql);
      return rows.find((row) => row.receipt_id === params[0]);
    },
    async all(sql) {
      statements.push(sql);
      return rows;
    },
  };
}

function createPostgresTestClient() {
  const rows = new Map();
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push(sql);
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
      return { rows: [...rows.values()].sort(compareSqlRows) };
    },
  };
}

function createPostgresNoStoreClient() {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    },
  };
}

function createPostgresStaticRowsClient(rows) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push(sql);
      if (sql.includes("WHERE receipt_id")) return { rows: rows.filter((row) => row.receipt_id === params[0]) };
      return { rows };
    },
  };
}

function makeSqlRow(receipt, overrides = {}) {
  return {
    receipt_id: receipt.receiptId,
    checksum: "test-checksum",
    created_at: receipt.createdAt,
    stored_at: 10,
    receipt_json: JSON.stringify(receipt),
    ...overrides,
  };
}

function compareSqlRows(a, b) {
  return a.created_at - b.created_at || a.receipt_id.localeCompare(b.receipt_id);
}
