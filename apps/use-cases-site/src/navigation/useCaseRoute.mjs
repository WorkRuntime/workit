/**
 * URL contract for shareable WorkIt use-case links.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export const USE_CASE_QUERY_PARAMETER = "example";
export const USE_CASE_SECTION_HASH = "#use-cases";

/** Resolve an allowlisted use-case id from a URL search string. */
export function resolveUseCaseId(search, availableIds, fallbackId) {
  const candidate = new URLSearchParams(search).get(USE_CASE_QUERY_PARAMETER);
  return candidate !== null && availableIds.includes(candidate) ? candidate : fallbackId;
}

/** Build a same-origin relative URL for a selected use case. */
export function buildUseCaseRoute(currentHref, useCaseId) {
  const url = new URL(currentHref);
  url.searchParams.set(USE_CASE_QUERY_PARAMETER, useCaseId);
  url.hash = USE_CASE_SECTION_HASH;
  return `${url.pathname}${url.search}${url.hash}`;
}
