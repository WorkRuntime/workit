/**
 * Browser client for the local WorkIt Node runtime API.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExampleRunResult } from "./types";

interface RuntimeLocation {
  hostname: string;
}

const localRuntimeHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const isViteDevRuntime = import.meta.env?.DEV === true;

/** Return whether the browser can reach the local Node runtime API. */
export function shouldUseLocalRuntime(
  location: RuntimeLocation | undefined = globalThis.location,
  isDevRuntime = isViteDevRuntime,
): boolean {
  return isDevRuntime && location !== undefined && localRuntimeHosts.has(location.hostname);
}

/** Execute an example through the local Node runner when it is available. */
export async function runLiveExample(exampleId: string): Promise<ExampleRunResult | null> {
  if (!shouldUseLocalRuntime()) {
    return null;
  }

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
