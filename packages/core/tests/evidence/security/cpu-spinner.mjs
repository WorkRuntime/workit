/**
 * Worker fixture that ignores cooperative cancellation and writes a late marker.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFileSync } from "node:fs";

export function spinForever({ durationMs, markerPath }) {
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    // Intentionally non-cooperative.
  }
  writeFileSync(markerPath, "completed");
  return { completed: true };
}
