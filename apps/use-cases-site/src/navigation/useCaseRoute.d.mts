/**
 * Type declarations for the shareable WorkIt use-case URL contract.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export declare const USE_CASE_QUERY_PARAMETER: "example";
export declare const USE_CASE_SECTION_HASH: "#use-cases";

export declare function resolveUseCaseId(
  search: string,
  availableIds: readonly string[],
  fallbackId: string,
): string;

export declare function buildUseCaseRoute(currentHref: string, useCaseId: string): string;
