/**
 * Non-cooperative CPU spinner used by bench 07.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The spin loop is intentionally signal-unaware. If the worker thread is
 * terminated before `durationMs` elapses, the late-marker file is never
 * written. The bench verifies the kill by checking the filesystem.
 */
import { writeFileSync } from "node:fs";

export function spin(opts) {
  const { durationMs, markerPath } = opts;
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    Math.sqrt(Math.random() * 1e6);
  }
  writeFileSync(markerPath, "late-marker-written-by-worker");
  return { completed: true, elapsedMs: Date.now() - start };
}
