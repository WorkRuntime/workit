/**
 * Live STT disconnect cleanup sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Demonstrates that a client disconnect aborts the in-flight transcription task
 * and closes the async audio source.
 */

import { CancellationError } from "../dist/index.js";
import { transcribeStream } from "../dist/ai/index.js";

const disconnect = new AbortController();
let sourceClosed = false;
let providerCancelled = false;
let markSecondStarted;
const secondStarted = new Promise((resolve) => {
  markSecondStarted = resolve;
});

async function* liveAudio() {
  try {
    yield "first";
    yield "second";
  } finally {
    sourceClosed = true;
  }
}

const iterator = transcribeStream(liveAudio(), {
  async transcribe(input, ctx) {
    if (input === "first") return "FIRST";
    markSecondStarted();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        providerCancelled = true;
        reject(ctx.signal.reason);
      }, { once: true });
    });
    return "SECOND";
  },
}, { signal: disconnect.signal })[Symbol.asyncIterator]();

const first = await iterator.next();
const pending = iterator.next();
await secondStarted;
disconnect.abort(new CancellationError({ kind: "manual", tag: "client_disconnect" }));
let reasonKind = "none";

try {
  await pending;
} catch (err) {
  reasonKind = err instanceof CancellationError ? err.reason.kind : "unknown";
}

console.log(JSON.stringify({
  sample: "stt-disconnect",
  first: first.value,
  providerCancelled,
  sourceClosed,
  reasonKind,
}));
