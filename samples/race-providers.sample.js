/**
 * Provider race sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Races three provider calls and cancels the losing requests through the shared
 * task signal.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../dist/index.js";

const cancelledProviders = [];

const winner = await run.race([
  provider("openai", 50),
  provider("anthropic", 10),
  provider("gemini", 80),
]);

assert.equal(winner.provider, "anthropic");
assert.deepEqual(cancelledProviders.sort(), ["gemini", "openai"]);

process.stdout.write(`${JSON.stringify({
  sample: "race-providers",
  winner: winner.provider,
  cancelledProviders: cancelledProviders.sort(),
})}\n`);

function provider(name, latencyMs) {
  return async (ctx) => {
    try {
      await sleep(latencyMs, ctx.signal);
      return { provider: name, text: `${name}:ok` };
    } catch (err) {
      if (err instanceof CancellationError) cancelledProviders.push(name);
      throw err;
    }
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
