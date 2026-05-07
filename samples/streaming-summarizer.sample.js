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

async function* documents() {
  for (let index = 0; index < 50; index++) {
    produced++;
    yield { id: index, text: `document-${index}` };
  }
}

const summaries = [];

for await (const summary of work(documents())
  .inParallel(5)
  .withRetry(2)
  .withTimeout("500ms")
  .map(async (doc, ctx) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(1, ctx.signal);
    active--;
    return `summary:${doc.id}`;
  })
  .stream()) {
  summaries.push(summary);
  if (summaries.length === 12) break;
}

assert.equal(summaries.length, 12);
assert.ok(produced <= 15);
assert.equal(maxActive, 5);

process.stdout.write(`${JSON.stringify({
  sample: "streaming-summarizer",
  summaries: summaries.length,
  produced,
  maxActive,
})}\n`);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
