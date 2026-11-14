/**
 * Release-line predicates shared by the release evidence proofs.
 *
 * Release proofs must hold for every release on a line, not for one
 * enumerated version. These predicates let a proof state "a final release on
 * the 1.x line" or "a baseline no newer than the package" without being
 * edited on each version bump.
 *
 * Only final `MAJOR.MINOR.PATCH` versions are release versions. Prerelease
 * and build-metadata versions, including the ephemeral dry-run version used by
 * the release workflow, are rejected.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

const RELEASE_VERSION =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;
const COMPONENTS = Object.freeze(["major", "minor", "patch"]);

/**
 * Parses a final release version.
 *
 * @param {unknown} version Candidate version, normally `package.json#version`.
 * @returns {{ major: number, minor: number, patch: number } | null} Numeric
 *   components, or `null` when the value is not a final release version.
 */
export function parseReleaseVersion(version) {
  const match = typeof version === "string" ? RELEASE_VERSION.exec(version) : null;
  if (match === null) return null;
  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
  };
}

/**
 * Reports whether a version is a final release on one major line.
 *
 * @param {unknown} version Candidate version.
 * @param {number} major Major line, for example `1` for every 1.x release.
 * @returns {boolean} `false` for other lines and for non-release versions.
 */
export function isReleaseOnMajorLine(version, major) {
  return parseReleaseVersion(version)?.major === major;
}

/**
 * Reports whether a release is the same as, or newer than, a floor release.
 *
 * @param {unknown} version Candidate version.
 * @param {unknown} floor Oldest accepted release.
 * @returns {boolean} `false` when either side is not a final release version.
 */
export function isReleaseAtOrAfter(version, floor) {
  const candidate = parseReleaseVersion(version);
  const minimum = parseReleaseVersion(floor);
  if (candidate === null || minimum === null) return false;
  for (const component of COMPONENTS) {
    if (candidate[component] !== minimum[component]) {
      return candidate[component] > minimum[component];
    }
  }
  return true;
}
