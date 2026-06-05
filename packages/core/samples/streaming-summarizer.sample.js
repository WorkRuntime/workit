/**
 * Streaming summarizer sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Streams transformed outputs from a bounded async source without materializing
 * the full source up front.
 */

import assert from "node:assert/strict";
import { work } from "../dist/index.js";

let produced = 0;
let active = 0;
let maxActive = 0;
const TAKE = 12;
const CONCURRENCY = 5;

async function* documents() {
  for (let index = 0; index < 50; index++) {
    produced++;
    yield { id: index, text: `document-${index}` };
  }
}

const summaries = [];

for await (const summary of work(documents())
  .inParallel(CONCURRENCY)
  .withRetry(2)
  .withTimeout("500ms")
  .map(async (doc, ctx) => {
    active++;
    try {
      maxActive = Math.max(maxActive, active);
      await sleep(1, ctx.signal);
      return `summary:${doc.id}`;
    } finally {
      active--;
    }
  })
  .stream()) {
  summaries.push(summary);
  if (summaries.length === TAKE) break;
}

assert.equal(summaries.length, TAKE);
assert.ok(produced <= TAKE + CONCURRENCY - 1);
assert.equal(maxActive, CONCURRENCY);
assert.equal(active, 0);

process.stdout.write(`${JSON.stringify({
  sample: "streaming-summarizer",
  summaries: summaries.length,
  produced,
  maxActive,
  active,
})}\n`);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
