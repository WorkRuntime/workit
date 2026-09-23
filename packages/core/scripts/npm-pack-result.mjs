/**
 * Normalizes the supported npm pack --json result shapes.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export function parseSingleNpmPackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm pack --json returned invalid JSON", { cause: error });
  }

  const results = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? Object.values(parsed)
      : [];

  if (results.length !== 1) {
    throw new Error(`npm pack --json must return exactly one package result; received ${results.length}`);
  }

  const [result] = results;
  if (!isRecord(result) || typeof result.filename !== "string" || result.filename.length === 0) {
    throw new Error("npm pack --json result must include a non-empty filename");
  }

  return result;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
