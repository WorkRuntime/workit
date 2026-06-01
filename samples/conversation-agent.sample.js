/**
 * Conversation agent sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs a chat turn with streaming, tool calls, memory write, and cleanup under
 * one WorkIt scope.
 */

import assert from "node:assert/strict";
import { run } from "../dist/index.js";

const tokens = [];
const cleanups = [];
let memoryWrites = 0;

const toolResults = await run.scope(async (scope) => {
  const stream = scope.spawn(async (ctx) => {
    ctx.defer(() => cleanups.push("stream"));
    for (const token of ["plan", "search", "edit", "reply"]) {
      await sleep(1, ctx.signal);
      tokens.push(token);
    }
    return tokens.length;
  }, { name: "llm.stream", kind: "llm" });

  const search = scope.spawn(async (ctx) => {
    ctx.defer(() => cleanups.push("tools"));
    await sleep(2, ctx.signal);
    return "search:2";
  }, { name: "tool.search", kind: "tool" });

  const repo = scope.spawn(async (ctx) => {
    await sleep(3, ctx.signal);
    return "repo:clean";
  }, { name: "tool.repo", kind: "tool" });

  const memory = scope.spawn(async (ctx) => {
    ctx.defer(() => cleanups.push("memory"));
    await sleep(4, ctx.signal);
    memoryWrites++;
    return memoryWrites;
  }, { name: "memory.write", kind: "io" });

  const results = await Promise.all([search, repo]);
  await Promise.all([stream, memory]);
  return results;
}, { name: "chat.turn" });

assert.deepEqual(tokens, ["plan", "search", "edit", "reply"]);
assert.deepEqual(toolResults, ["search:2", "repo:clean"]);
assert.equal(memoryWrites, 1);
assert.deepEqual(cleanups.sort(), ["memory", "stream", "tools"]);

process.stdout.write(`${JSON.stringify({
  sample: "conversation-agent",
  tokens,
  toolResults,
  memoryWrites,
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
