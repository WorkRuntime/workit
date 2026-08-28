/**
 * Shared property-test execution policy.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

const DEFAULT_PROPERTY_RUNS = 35;
const MAXIMUM_PROPERTY_RUNS = 100_000;
const MAXIMUM_SEED_OFFSET = 1_000_000_000;
const rawRuns = process.env.WORKIT_PROPERTY_RUNS;
const configuredRuns = rawRuns === undefined
  ? DEFAULT_PROPERTY_RUNS
  : Number.parseInt(rawRuns, 10);

if (
  !Number.isSafeInteger(configuredRuns)
  || configuredRuns < 1
  || configuredRuns > MAXIMUM_PROPERTY_RUNS
) {
  throw new RangeError(
    `WORKIT_PROPERTY_RUNS must be an integer from 1 through ${MAXIMUM_PROPERTY_RUNS}`
  );
}

export const PROPERTY_RUNS = configuredRuns;

const rawSeedOffset = process.env.WORKIT_PROPERTY_SEED_OFFSET;
const configuredSeedOffset = rawSeedOffset === undefined
  ? 0
  : Number.parseInt(rawSeedOffset, 10);

if (
  !Number.isSafeInteger(configuredSeedOffset)
  || configuredSeedOffset < 0
  || configuredSeedOffset > MAXIMUM_SEED_OFFSET
) {
  throw new RangeError(
    `WORKIT_PROPERTY_SEED_OFFSET must be an integer from 0 through ${MAXIMUM_SEED_OFFSET}`
  );
}

export const propertySeed = (baseSeed) => (baseSeed + configuredSeedOffset) | 0;
