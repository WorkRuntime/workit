/**
 * Regression tests for shareable WorkIt use-case links.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUseCaseRoute,
  resolveUseCaseId,
  USE_CASE_SECTION_HASH,
} from "../src/navigation/useCaseRoute.mjs";

const USE_CASE_IDS = Object.freeze([
  "vibe-coding-agent",
  "conversation-agent",
  "provider-fallback",
  "incident-decision-gate",
  "rag-pipeline",
]);
const FALLBACK_ID = USE_CASE_IDS[0];

for (const useCaseId of USE_CASE_IDS) {
  test(`resolves the ${useCaseId} deep link`, () => {
    assert.equal(resolveUseCaseId(`?example=${useCaseId}`, USE_CASE_IDS, FALLBACK_ID), useCaseId);
  });
}

test("rejects unknown and encoded hostile use-case ids", () => {
  assert.equal(resolveUseCaseId("?example=unknown", USE_CASE_IDS, FALLBACK_ID), FALLBACK_ID);
  assert.equal(resolveUseCaseId("?example=%2F%2Fevil.example", USE_CASE_IDS, FALLBACK_ID), FALLBACK_ID);
});

test("builds a relative same-origin route and preserves unrelated query state", () => {
  const route = buildUseCaseRoute(
    "https://workruntime.github.io/workit/?source=article#failure-lab",
    "incident-decision-gate",
  );

  assert.equal(
    route,
    `/workit/?source=article&example=incident-decision-gate${USE_CASE_SECTION_HASH}`,
  );
  assert.equal(route.includes("workruntime.github.io"), false);
});
