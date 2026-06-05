/**
 * Exporter-down memory stress check.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Exercises the compiled telemetry bridge under sustained exporter failure.
 * The requirement is not that telemetry succeeds; it is that failure remains
 * bounded and cannot retain an unbounded queue.
 */

import { setTimeout as delay } from "node:timers/promises";
import { attachTelemetryExporter } from "../dist/observability/index.js";
import { group } from "../dist/index.js";

const SCOPES = 1_000;
const EVENTS_PER_SCOPE = 100;
const MAX_HEAP_GROWTH_BYTES = 64 * 1024 * 1024;

if (typeof globalThis.gc !== "function") {
  console.error("Exporter stress requires Node to run with --expose-gc.");
  process.exit(1);
}

const forceGc = () => {
  for (let i = 0; i < 3; i++) globalThis.gc();
};

forceGc();
const before = process.memoryUsage().heapUsed;

let exported = 0;
let dropped = 0;
let openTransitions = 0;
let maxQueued = 0;

for (let scopeIndex = 0; scopeIndex < SCOPES; scopeIndex++) {
  let attachment;
  await group(async (task) => {
    await task(async (ctx) => {
      attachment = attachTelemetryExporter(
        ctx.scope,
        async () => {
          throw new Error("telemetry backend unavailable");
        },
        {
          sampling: { mode: "all" },
          queue: { maxItems: 8 },
          circuitBreaker: { failureThreshold: 2, openForMs: 60_000 },
          onStateChange(event) {
            if (event.to === "open") openTransitions++;
          },
        }
      );

      for (let eventIndex = 0; eventIndex < EVENTS_PER_SCOPE; eventIndex++) {
        ctx.report({ pct: eventIndex / EVENTS_PER_SCOPE });
        maxQueued = Math.max(maxQueued, attachment.queuedCount());
      }
    }, { name: "exporter-stress-task" });
  }, { name: "exporter-stress-scope" });

  await waitForQueueToDrain(attachment);
  exported += attachment.exportedCount();
  dropped += attachment.droppedCount();
  maxQueued = Math.max(maxQueued, attachment.queuedCount());
  attachment.unsubscribe();
}

await delay(0);
forceGc();

const after = process.memoryUsage().heapUsed;
const growth = Math.max(0, after - before);

console.log(
  `exporter-stress: ${SCOPES * EVENTS_PER_SCOPE} events, ` +
    `${dropped} dropped, ${exported} exported, max queue ${maxQueued}, ` +
    `heap growth ${growth} B (limit ${MAX_HEAP_GROWTH_BYTES} B)`
);

if (openTransitions === 0) {
  console.error("Exporter circuit breaker never opened during failure stress.");
  process.exit(1);
}

if (maxQueued > 8) {
  console.error(`Exporter queue exceeded configured bound: ${maxQueued}`);
  process.exit(1);
}

if (exported !== 0 || dropped === 0) {
  console.error("Exporter failure stress did not drop failed telemetry as expected.");
  process.exit(1);
}

if (growth > MAX_HEAP_GROWTH_BYTES) {
  console.error("Heap growth exceeded exporter stress limit.");
  process.exit(1);
}

async function waitForQueueToDrain(attachment) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (attachment.queuedCount() === 0) return;
    await delay(1);
  }
  throw new Error("Timed out waiting for telemetry export queue to drain");
}
