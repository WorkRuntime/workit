/**
 * Browser client for the local WorkIt Node runtime API.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExampleRunResult } from "./types";

/** Execute an example through the local Node runner when it is available. */
export async function runLiveExample(exampleId: string): Promise<ExampleRunResult | null> {
  try {
    const response = await fetch(`/api/examples/${encodeURIComponent(exampleId)}/run`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const value: unknown = await response.json();
    return isExampleRunResult(value) ? value : null;
  } catch {
    return null;
  }
}

function isExampleRunResult(value: unknown): value is ExampleRunResult {
  if (!isRecord(value)) {
    return false;
  }

  return (value.source === "live-node" || value.source === "captured-build")
    && typeof value.sample === "string"
    && isStringArray(value.events)
    && isStringArray(value.receipt)
    && (value.code === undefined || typeof value.code === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
