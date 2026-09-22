/**
 * URL contract for shareable WorkIt AI Failure Lab scenarios.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export const SCENARIO_QUERY_PARAMETER = "scenario";
export const FAILURE_LAB_SECTION_HASH = "#failure-lab";

/** Resolve an allowlisted scenario id from a URL search string. */
export function resolveScenarioId(search, availableIds, fallbackId) {
  const candidate = new URLSearchParams(search).get(SCENARIO_QUERY_PARAMETER);
  return candidate !== null && availableIds.includes(candidate) ? candidate : fallbackId;
}

/** Build a same-origin relative URL for a selected failure-lab scenario. */
export function buildScenarioRoute(currentHref, scenarioId) {
  const url = new URL(currentHref);
  url.searchParams.set(SCENARIO_QUERY_PARAMETER, scenarioId);
  url.hash = FAILURE_LAB_SECTION_HASH;
  return `${url.pathname}${url.search}${url.hash}`;
}
