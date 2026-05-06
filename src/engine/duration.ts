/**
 * Duration parser for boundary validation.
 *
 * @author Admilson B. F. Cossa
 *
 * The parser is intentionally strict because duration values affect
 * cancellation policy; malformed values must fail before task execution begins.
 *
 * Accepted values:
 * - "500ms"
 * - "3s"
 * - "5m"
 * - "2h"
 * - raw finite numbers, interpreted as milliseconds
 *
 * Rejected values include negative numbers, NaN, Infinity, empty strings, and
 * fractional unit strings such as "1.5ms".
 */

import type { Duration } from "../types/index.js";

const PATTERN = /^(\d+)(ms|s|m|h)$/;
const MULTIPLIERS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

/**
 * Converts a WorkJS duration into milliseconds.
 *
 * @throws RangeError when the value is not a finite non-negative duration.
 */
export function parseDuration(d: Duration): number {
  if (typeof d === "number") {
    if (!Number.isFinite(d) || d < 0) {
      throw new RangeError(`Invalid duration: ${d}`);
    }
    return d;
  }
  const m = PATTERN.exec(d);
  if (!m) {
    throw new RangeError(`Invalid duration string: "${d}". Use e.g. "500ms", "3s", "5m", "2h".`);
  }
  const n = Number(m[1]);
  const unit = m[2] as keyof typeof MULTIPLIERS;
  return n * MULTIPLIERS[unit];
}
