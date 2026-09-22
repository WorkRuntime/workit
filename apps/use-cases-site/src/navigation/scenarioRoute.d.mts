/**
 * Type contract for shareable WorkIt AI Failure Lab scenario links.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export const SCENARIO_QUERY_PARAMETER: "scenario";
export const FAILURE_LAB_SECTION_HASH: "#failure-lab";

export function resolveScenarioId(
  search: string,
  availableIds: readonly string[],
  fallbackId: string,
): string;

export function buildScenarioRoute(currentHref: string, scenarioId: string): string;
