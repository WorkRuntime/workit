/**
 * Event bus depth tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { EventBus } from "../../dist/engine/event-bus.js";

test("EventBus bubbles through deep parent chains without recursive stack growth", () => {
  const root = new EventBus();
  let seen = 0;
  root.on(() => {
    seen++;
  });

  let leaf = root;
  for (let depth = 0; depth < 20_000; depth++) {
    leaf = new EventBus(leaf);
  }

  leaf.emit({ type: "task:progress", taskId: "deep-event", at: 1 });

  assert.equal(seen, 1);
});
