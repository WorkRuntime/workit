/**
 * Release-line predicate tests for the release evidence proofs.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import {
  isReleaseAtOrAfter,
  isReleaseOnMajorLine,
  parseReleaseVersion,
} from "../../scripts/release-line.mjs";

describe("release version parsing", () => {
  it("parses final MAJOR.MINOR.PATCH versions numerically", () => {
    expect(parseReleaseVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseReleaseVersion("10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it.each([
    "1.0",
    "1.0.0.0",
    "v1.0.0",
    "01.0.0",
    "1.0.0-rc.1",
    "0.0.0-dry-run.42.1",
    "1.0.0+build.7",
    "",
    " 1.0.0",
  ])("rejects %j because it is not a final release version", (version) => {
    expect(parseReleaseVersion(version)).toBeNull();
  });

  it.each([undefined, null, 1, { major: 1 }])("rejects the non-string value %j", (version) => {
    expect(parseReleaseVersion(version)).toBeNull();
  });
});

describe("release major line", () => {
  it("accepts every final release on the requested major line", () => {
    expect(isReleaseOnMajorLine("1.0.0", 1)).toBe(true);
    expect(isReleaseOnMajorLine("1.0.1", 1)).toBe(true);
    expect(isReleaseOnMajorLine("1.7.12", 1)).toBe(true);
  });

  it("rejects other major lines and non-release versions", () => {
    expect(isReleaseOnMajorLine("0.6.1", 1)).toBe(false);
    expect(isReleaseOnMajorLine("2.0.0", 1)).toBe(false);
    expect(isReleaseOnMajorLine("1.0.1-rc.1", 1)).toBe(false);
    expect(isReleaseOnMajorLine(undefined, 1)).toBe(false);
  });
});

describe("release ordering", () => {
  it("treats a release as at or after itself", () => {
    expect(isReleaseAtOrAfter("1.0.0", "1.0.0")).toBe(true);
  });

  it("orders by major, then minor, then patch", () => {
    expect(isReleaseAtOrAfter("1.0.1", "1.0.0")).toBe(true);
    expect(isReleaseAtOrAfter("1.1.0", "1.0.9")).toBe(true);
    expect(isReleaseAtOrAfter("2.0.0", "1.9.9")).toBe(true);
    expect(isReleaseAtOrAfter("1.0.0", "1.0.1")).toBe(false);
    expect(isReleaseAtOrAfter("1.0.9", "1.1.0")).toBe(false);
    expect(isReleaseAtOrAfter("0.6.1", "1.0.0")).toBe(false);
  });

  it("compares components as numbers, not strings", () => {
    expect(isReleaseAtOrAfter("1.0.10", "1.0.9")).toBe(true);
    expect(isReleaseAtOrAfter("1.10.0", "1.9.0")).toBe(true);
    expect(isReleaseAtOrAfter("1.0.9", "1.0.10")).toBe(false);
  });

  it("is false when either side is not a final release version", () => {
    expect(isReleaseAtOrAfter("1.0.1-rc.1", "1.0.0")).toBe(false);
    expect(isReleaseAtOrAfter("1.0.1", "1.0")).toBe(false);
    expect(isReleaseAtOrAfter(undefined, "1.0.0")).toBe(false);
  });
});
