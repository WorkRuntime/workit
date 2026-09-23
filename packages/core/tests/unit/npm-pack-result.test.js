/**
 * npm pack JSON compatibility tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { parseSingleNpmPackResult } from "../../scripts/npm-pack-result.mjs";

describe("parseSingleNpmPackResult", () => {
  it("accepts the npm 10 and 11 array result", () => {
    expect(parseSingleNpmPackResult(JSON.stringify([
      { filename: "workit-core-1.0.0.tgz", name: "@workit/core" },
    ]))).toMatchObject({ filename: "workit-core-1.0.0.tgz" });
  });

  it("accepts the npm 12 workspace-keyed result", () => {
    expect(parseSingleNpmPackResult(JSON.stringify({
      "@workit/core": { filename: "workit-core-1.0.0.tgz", name: "@workit/core" },
    }))).toMatchObject({ filename: "workit-core-1.0.0.tgz" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["a non-collection result", "null"],
    ["no package results", "[]"],
    ["multiple package results", JSON.stringify([{ filename: "a.tgz" }, { filename: "b.tgz" }])],
    ["a missing filename", JSON.stringify([{}])],
  ])("rejects %s", (_case, stdout) => {
    expect(() => parseSingleNpmPackResult(stdout)).toThrow();
  });
});
