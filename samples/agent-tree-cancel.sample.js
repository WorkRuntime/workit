/**
 * Agent tree cancellation sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Demonstrates parent-scope cancellation across multiple in-flight tool tasks.
 * Each task receives the same typed cancellation reason and runs cleanup.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../dist/index.js";

const cancelled = [];
const cleanups = [];

await run.scope(async (scope) => {
  const tools = ["search", "browser", "code"];
  const handles = tools.map((name) => scope.spawn(async (ctx) => {
    ctx.defer(() => cleanups.push(name));
    try {
      await sleep(1_000, ctx.signal);
      return name;
    } catch (err) {
      if (err instanceof CancellationError) {
        cancelled.push({ name, reason: err.reason });
      }
      throw err;
    }
  }, { name: `tool.${name}`, kind: "tool" }));

  await sleep(5, scope.signal);
  scope.cancel({ kind: "manual", tag: "user_stopped_agent" });
  await Promise.allSettled(handles);
}, { name: "agent.tree" });

assert.deepEqual(cancelled.map((item) => item.name).sort(), ["browser", "code", "search"]);
assert.deepEqual(cleanups.sort(), ["browser", "code", "search"]);
assert.ok(cancelled.every((item) => item.reason.tag === "user_stopped_agent"));

process.stdout.write(`${JSON.stringify({
  sample: "agent-tree-cancel",
  cancelled: cancelled.map((item) => item.name).sort(),
  reason: cancelled[0]?.reason,
  cleanups: cleanups.sort(),
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
