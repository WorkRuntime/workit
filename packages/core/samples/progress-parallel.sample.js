/**
 * Parallel progress tracking sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shows how to watch one specific named task while many sibling tasks run in
 * parallel. Progress is collected from typed task events, not console output.
 */

import assert from "node:assert/strict";
import { run } from "../dist/index.js";

const TARGET_NAME = "embed.batch.7";
const TOTAL = 16;
const CONCURRENCY = TOTAL;
const taskNames = new Map();
const targetProgress = [];
let active = 0;
let maxActive = 0;

const results = await run.scope(async (scope) => {
  scope.onEvent((event) => {
    if (event.type === "task:started") {
      taskNames.set(event.taskId, event.name);
    }
    if (event.type === "task:progress" && taskNames.get(event.taskId) === TARGET_NAME) {
      targetProgress.push({ pct: event.pct, message: event.message });
    }
  });

  const handles = Array.from({ length: TOTAL }, (_, index) => scope.spawn(async (ctx) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (index === 7) {
      for (const step of [1, 2, 3, 4]) {
        ctx.report({ pct: step / 4, message: `chunk-${step}` });
        await sleep(1, ctx.signal);
      }
    } else {
      await sleep(8, ctx.signal);
    }
    active--;
    return index;
  }, { name: `embed.batch.${index}`, kind: "llm" }));

  return await Promise.all(handles);
}, { name: "progress.parallel" });

assert.equal(results.length, TOTAL);
assert.equal(maxActive, CONCURRENCY);
assert.deepEqual(targetProgress.map((event) => event.pct), [0.25, 0.5, 0.75, 1]);

process.stdout.write(`${JSON.stringify({
  sample: "progress-parallel",
  target: TARGET_NAME,
  totalTasks: TOTAL,
  concurrency: CONCURRENCY,
  maxActive,
  progress: targetProgress,
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
