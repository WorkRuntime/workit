/**
 * Correctness evidence for telemetry failure isolation introduced in 0.5.0.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventBus } from "../../../dist/engine/event-bus.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-035",
  "telemetry context and observer failures remain isolated",
  "throwing context access and one throwing observer cannot interrupt delivery to another observer or escape event emission",
  async () => {
    const bus = new EventBus();
    const delivered = [];
    bus.on(() => { throw new Error("observer failed"); });
    bus.on((event) => delivered.push(event.type));
    const hostileContext = {
      get() { throw new Error("context failed"); },
    };
    const event = {
      type: "scope:closed",
      scopeId: "scope-evidence",
      durationMs: 1,
      at: Date.now(),
    };

    let contextEscaped = false;
    let observerEscaped = false;
    try { bus.emit(event, hostileContext); } catch { contextEscaped = true; }
    try { bus.emit(event); } catch { observerEscaped = true; }

    return {
      ok: !contextEscaped && !observerEscaped && JSON.stringify(delivered) === JSON.stringify(["scope:closed"]),
      contextEscaped,
      observerEscaped,
      delivered,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
