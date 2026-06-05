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

interface StoredReceipt {
  readonly record: ReceiptLedgerRecord;
  readonly receipt: WorkItReceipt;
}

const DEFAULT_MAX_MEMORY_RECEIPTS = 10_000;

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
  const maxReceipts = opts.maxReceipts ?? DEFAULT_MAX_MEMORY_RECEIPTS;
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
