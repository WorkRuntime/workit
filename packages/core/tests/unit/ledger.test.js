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
  const ledger = createMemoryReceiptLedger({ clock: () => 10 });
  const receipt = makeReceipt("receipt-memory");

  const first = await ledger.append(receipt);
  const second = await ledger.append(receipt);

  assert.equal(first.receiptId, "receipt-memory");
  assert.equal(first.storedAt, 10);
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
    const firstLedger = createFileReceiptLedger({ dir, clock: () => 10 });
    const firstRecord = await firstLedger.append(receipt);

    const secondLedger = createFileReceiptLedger({ dir });
    const restored = await secondLedger.get("receipt-file");
    const listed = await secondLedger.list();

    assert.equal(restored.receiptId, "receipt-file");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].checksum, firstRecord.checksum);
    assert.equal(firstRecord.storedAt, 10);
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

test("Given the root import, ledger helpers are not exported from the root runtime", async () => {
  const root = await import("../../dist/index.js");

  assert.equal("createMemoryReceiptLedger" in root, false);
  assert.equal("createFileReceiptLedger" in root, false);
});
