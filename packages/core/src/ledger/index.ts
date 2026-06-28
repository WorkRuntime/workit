/**
 * Receipt ledger adapters for WorkIt lifecycle receipts.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ledgers provide idempotent append and retrieval for replay receipts. The file
 * adapter uses atomic write-then-rename so receipt storage has a durable path
 * without adding runtime dependencies.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItReceipt } from "../replay/index.js";

type MaybePromise<T> = T | Promise<T>;

/** Stored receipt metadata returned by ledger appends and listings. */
export interface ReceiptLedgerRecord {
  readonly receiptId: string;
  readonly checksum: string;
  readonly createdAt: number;
  readonly storedAt: number;
}

/** Append-only receipt ledger contract. */
export interface ReceiptLedger {
  append(receipt: WorkItReceipt): Promise<ReceiptLedgerRecord>;
  get(receiptId: string): Promise<WorkItReceipt | undefined>;
  list(): Promise<readonly ReceiptLedgerRecord[]>;
}

/** Options for in-memory receipt ledgers. */
export interface MemoryReceiptLedgerOptions {
  readonly clock?: () => number;
  readonly maxReceipts?: number;
}

/** Options for file-backed receipt ledgers. */
export interface FileReceiptLedgerOptions {
  readonly dir: string;
  readonly clock?: () => number;
}

/** Minimal SQLite client port used by the receipt ledger adapter. */
export interface SqliteReceiptLedgerClient {
  exec(sql: string): MaybePromise<unknown>;
  run(sql: string, params?: readonly unknown[]): MaybePromise<unknown>;
  get<T = unknown>(sql: string, params?: readonly unknown[]): MaybePromise<T | undefined>;
  all<T = unknown>(sql: string, params?: readonly unknown[]): MaybePromise<readonly T[]>;
}

/** Options for SQLite-backed receipt ledgers. */
export interface SqliteReceiptLedgerOptions {
  readonly db: SqliteReceiptLedgerClient;
  readonly tableName?: string;
  readonly clock?: () => number;
}

/** Minimal Postgres client port used by the receipt ledger adapter. */
export interface PostgresReceiptLedgerClient {
  query<T = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): MaybePromise<{ readonly rows: readonly T[] }>;
}

/** Options for Postgres-backed receipt ledgers. */
export interface PostgresReceiptLedgerOptions {
  readonly db: PostgresReceiptLedgerClient;
  readonly tableName?: string;
  readonly clock?: () => number;
}

interface StoredReceipt {
  readonly record: ReceiptLedgerRecord;
  readonly receipt: WorkItReceipt;
}

interface SqlReceiptRow {
  readonly receipt_id: unknown;
  readonly checksum: unknown;
  readonly created_at: unknown;
  readonly stored_at: unknown;
  readonly receipt_json: unknown;
}

const DEFAULT_SQL_LEDGER_TABLE = "workit_receipts";
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Error thrown when the same receipt id is appended with different content. */
export class ReceiptLedgerConflictError extends Error {
  readonly receiptId: string;

  constructor(receiptId: string) {
    super(`Receipt ledger conflict for receipt id "${receiptId}"`);
    this.name = "ReceiptLedgerConflictError";
    this.receiptId = receiptId;
  }
}

/** Creates a bounded in-memory receipt ledger for tests and short-lived processes. */
export function createMemoryReceiptLedger(opts: MemoryReceiptLedgerOptions = {}): ReceiptLedger {
  const maxReceipts = opts.maxReceipts ?? 10_000;
  if (!Number.isInteger(maxReceipts) || maxReceipts < 1) {
    throw new RangeError("maxReceipts must be a positive integer");
  }

  const entries = new Map<string, StoredReceipt>();
  const clock = opts.clock ?? Date.now;

  return {
    async append(receipt) {
      const checksum = checksumReceipt(receipt);
      const existing = entries.get(receipt.receiptId);
      if (existing !== undefined) {
        if (existing.record.checksum !== checksum) throw new ReceiptLedgerConflictError(receipt.receiptId);
        return existing.record;
      }

      if (entries.size >= maxReceipts) {
        const oldest = entries.keys().next().value;
        /* v8 ignore else -- size >= maxReceipts guarantees a map key is available. */
        if (oldest !== undefined) entries.delete(oldest);
      }

      const record = makeRecord(receipt, checksum, clock);
      entries.set(receipt.receiptId, { record, receipt });
      return record;
    },
    async get(receiptId) {
      return entries.get(receiptId)?.receipt;
    },
    async list() {
      return [...entries.values()]
        .map((entry) => entry.record)
        .sort(compareRecords);
    },
  };
}

/** Creates a SQLite-backed append-only receipt ledger through a caller-owned database client. */
export function createSqliteReceiptLedger(opts: SqliteReceiptLedgerOptions): ReceiptLedger {
  const table = quoteSqlIdentifierPath(opts.tableName ?? DEFAULT_SQL_LEDGER_TABLE);
  const clock = opts.clock ?? Date.now;
  let initialized = false;

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    await opts.db.exec([
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      "receipt_id TEXT PRIMARY KEY,",
      "checksum TEXT NOT NULL,",
      "created_at INTEGER NOT NULL,",
      "stored_at INTEGER NOT NULL,",
      "receipt_json TEXT NOT NULL",
      ")",
    ].join(" "));
    initialized = true;
  };

  const readStored = async (receiptId: string): Promise<StoredReceipt | undefined> => {
    const row = await opts.db.get<SqlReceiptRow>(
      `SELECT receipt_id, checksum, created_at, stored_at, receipt_json FROM ${table} WHERE receipt_id = ?`,
      [receiptId],
    );
    return row === undefined ? undefined : sqlRowToStoredReceipt(row);
  };

  return {
    async append(receipt) {
      await ensureInitialized();
      const checksum = checksumReceipt(receipt);
      const storedAt = clock();
      await opts.db.run(
        [
          `INSERT OR IGNORE INTO ${table}`,
          "(receipt_id, checksum, created_at, stored_at, receipt_json)",
          "VALUES (?, ?, ?, ?, ?)",
        ].join(" "),
        [receipt.receiptId, checksum, receipt.createdAt, storedAt, JSON.stringify(receipt)],
      );

      const stored = await readStored(receipt.receiptId);
      return finalizeStoredReceipt(receipt.receiptId, checksum, stored);
    },
    async get(receiptId) {
      await ensureInitialized();
      return (await readStored(receiptId))?.receipt;
    },
    async list() {
      await ensureInitialized();
      const rows = await opts.db.all<SqlReceiptRow>(
        `SELECT receipt_id, checksum, created_at, stored_at, receipt_json FROM ${table} ORDER BY created_at ASC, receipt_id ASC`,
      );
      return rows.map(sqlRowToStoredReceipt).map((stored) => stored.record);
    },
  };
}

/** Creates a Postgres-backed append-only receipt ledger through a caller-owned database client. */
export function createPostgresReceiptLedger(opts: PostgresReceiptLedgerOptions): ReceiptLedger {
  const table = quoteSqlIdentifierPath(opts.tableName ?? DEFAULT_SQL_LEDGER_TABLE);
  const clock = opts.clock ?? Date.now;
  let initialized = false;

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    await opts.db.query([
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      "receipt_id TEXT PRIMARY KEY,",
      "checksum TEXT NOT NULL,",
      "created_at BIGINT NOT NULL,",
      "stored_at BIGINT NOT NULL,",
      "receipt_json JSONB NOT NULL",
      ")",
    ].join(" "));
    initialized = true;
  };

  const readStored = async (receiptId: string): Promise<StoredReceipt | undefined> => {
    const result = await opts.db.query<SqlReceiptRow>(
      `SELECT receipt_id, checksum, created_at, stored_at, receipt_json FROM ${table} WHERE receipt_id = $1`,
      [receiptId],
    );
    return result.rows[0] === undefined ? undefined : sqlRowToStoredReceipt(result.rows[0]);
  };

  return {
    async append(receipt) {
      await ensureInitialized();
      const checksum = checksumReceipt(receipt);
      const storedAt = clock();
      const result = await opts.db.query<SqlReceiptRow>(
        [
          `INSERT INTO ${table}`,
          "(receipt_id, checksum, created_at, stored_at, receipt_json)",
          "VALUES ($1, $2, $3, $4, $5::jsonb)",
          "ON CONFLICT (receipt_id) DO NOTHING",
          "RETURNING receipt_id, checksum, created_at, stored_at, receipt_json",
        ].join(" "),
        [receipt.receiptId, checksum, receipt.createdAt, storedAt, JSON.stringify(receipt)],
      );
      const stored = result.rows[0] === undefined
        ? await readStored(receipt.receiptId)
        : sqlRowToStoredReceipt(result.rows[0]);

      return finalizeStoredReceipt(receipt.receiptId, checksum, stored);
    },
    async get(receiptId) {
      await ensureInitialized();
      return (await readStored(receiptId))?.receipt;
    },
    async list() {
      await ensureInitialized();
      const result = await opts.db.query<SqlReceiptRow>(
        `SELECT receipt_id, checksum, created_at, stored_at, receipt_json FROM ${table} ORDER BY created_at ASC, receipt_id ASC`,
      );
      return result.rows.map(sqlRowToStoredReceipt).map((stored) => stored.record);
    },
  };
}

/** Creates a file-backed receipt ledger rooted at one directory. */
export function createFileReceiptLedger(opts: FileReceiptLedgerOptions): ReceiptLedger {
  const clock = opts.clock ?? Date.now;

  return {
    async append(receipt) {
      await mkdir(opts.dir, { recursive: true });
      const file = receiptPath(opts.dir, receipt.receiptId);
      const checksum = checksumReceipt(receipt);
      const existing = await readStoredReceipt(file);
      if (existing !== undefined) {
        if (existing.record.checksum !== checksum) throw new ReceiptLedgerConflictError(receipt.receiptId);
        return existing.record;
      }

      const record = makeRecord(receipt, checksum, clock);
      const stored: StoredReceipt = { record, receipt };
      const temp = `${file}.${process.pid}.${clock()}.tmp`;
      await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      await rename(temp, file);
      return record;
    },
    async get(receiptId) {
      const stored = await readStoredReceipt(receiptPath(opts.dir, receiptId));
      return stored?.receipt;
    },
    async list() {
      await mkdir(opts.dir, { recursive: true });
      const names = await readdir(opts.dir);
      const records: ReceiptLedgerRecord[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const stored = await readStoredReceipt(join(opts.dir, name));
        /* v8 ignore else -- undefined is possible only if another process deletes the file between readdir and read. */
        if (stored !== undefined) records.push(stored.record);
      }
      return records.sort(compareRecords);
    },
  };
}

function makeRecord(receipt: WorkItReceipt, checksum: string, clock: () => number): ReceiptLedgerRecord {
  return {
    receiptId: receipt.receiptId,
    checksum,
    createdAt: receipt.createdAt,
    storedAt: clock(),
  };
}

function checksumReceipt(receipt: WorkItReceipt): string {
  return createHash("sha256").update(stableStringify(receipt)).digest("hex");
}

function finalizeStoredReceipt(
  receiptId: string,
  checksum: string,
  stored: StoredReceipt | undefined,
): ReceiptLedgerRecord {
  if (stored === undefined) throw new Error(`Receipt ledger append did not store receipt id "${receiptId}"`);
  if (stored.record.checksum !== checksum) throw new ReceiptLedgerConflictError(receiptId);
  return stored.record;
}

function sqlRowToStoredReceipt(row: SqlReceiptRow): StoredReceipt {
  const receiptId = readSqlString(row.receipt_id, "receipt_id");
  const checksum = readSqlString(row.checksum, "checksum");
  const createdAt = readSqlNumber(row.created_at, "created_at");
  const storedAt = readSqlNumber(row.stored_at, "stored_at");
  const receipt = readSqlReceipt(row.receipt_json);
  return {
    record: {
      receiptId,
      checksum,
      createdAt,
      storedAt,
    },
    receipt,
  };
}

function readSqlString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`receipt ledger SQL field "${field}" must be a string`);
  return value;
}

function readSqlNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`receipt ledger SQL field "${field}" must be numeric`);
  return parsed;
}

function readSqlReceipt(value: unknown): WorkItReceipt {
  if (typeof value === "string") return JSON.parse(value) as WorkItReceipt;
  if (typeof value === "object" && value !== null) return value as WorkItReceipt;
  throw new TypeError("receipt ledger SQL field \"receipt_json\" must be JSON");
}

async function readStoredReceipt(file: string): Promise<StoredReceipt | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredReceipt;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function receiptPath(dir: string, receiptId: string): string {
  return join(dir, `${Buffer.from(receiptId, "utf8").toString("base64url")}.json`);
}

function quoteSqlIdentifierPath(input: string): string {
  const parts = input.split(".");

  return parts.map((part) => {
    if (!SQL_IDENTIFIER_RE.test(part)) {
      throw new RangeError(`SQL identifier "${input}" contains an unsafe segment`);
    }
    return `"${part}"`;
  }).join(".");
}

function compareRecords(a: ReceiptLedgerRecord, b: ReceiptLedgerRecord): number {
  return a.createdAt - b.createdAt || a.receiptId.localeCompare(b.receiptId);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return output;
}
