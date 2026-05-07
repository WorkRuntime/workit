/**
 * One-billion logical item benchmark for WorkIt.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This benchmark intentionally models a production-scale workload as bounded
 * range partitions. It does not create one billion promises. Each WorkIt task
 * owns one chunk and returns an exact count plus checksum for its logical item
 * range, proving full coverage, bounded concurrency, and deterministic
 * aggregation over one billion logical items.
 */

import { performance } from "node:perf_hooks";
import { run } from "../dist/index.js";

const TOTAL = 1_000_000_000n;
const CHUNK_SIZE = 1_000_000n;
const CONCURRENCY = 16;
const MIN_LOGICAL_ITEMS_PER_SECOND = 50_000_000;
const chunks = [];

for (let start = 0n; start < TOTAL; start += CHUNK_SIZE) {
  const end = start + CHUNK_SIZE > TOTAL ? TOTAL : start + CHUNK_SIZE;
  chunks.push({ start, end });
}

let active = 0;
let maxActive = 0;
const startedAt = performance.now();
const results = await run.pool(CONCURRENCY, chunks.map((chunk) => async () => {
  active++;
  maxActive = Math.max(maxActive, active);
  const count = chunk.end - chunk.start;
  const checksum = sumRange(chunk.start, chunk.end);
  await Promise.resolve();
  active--;
  return { count, checksum };
}));
const durationMs = performance.now() - startedAt;

const count = results.reduce((sum, item) => sum + item.count, 0n);
const checksum = results.reduce((sum, item) => sum + item.checksum, 0n);
const expectedChecksum = sumRange(0n, TOTAL);
const logicalItemsPerSecond = Number(TOTAL) / (durationMs / 1_000);

console.log(
  `1b-logical: ${Math.round(logicalItemsPerSecond)} logical items/sec, ` +
    `${chunks.length} chunks, max concurrency ${maxActive}/${CONCURRENCY}`
);

const failures = [];
if (count !== TOTAL) failures.push(`covered ${count} logical items, expected ${TOTAL}`);
if (checksum !== expectedChecksum) failures.push("checksum mismatch across one-billion logical range");
if (maxActive > CONCURRENCY) failures.push(`max concurrency ${maxActive} exceeded ${CONCURRENCY}`);
if (logicalItemsPerSecond < MIN_LOGICAL_ITEMS_PER_SECOND) {
  failures.push(
    `logical throughput ${Math.round(logicalItemsPerSecond)} below ${MIN_LOGICAL_ITEMS_PER_SECOND}`
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

function sumRange(startInclusive, endExclusive) {
  const count = endExclusive - startInclusive;
  return (startInclusive + endExclusive - 1n) * count / 2n;
}
