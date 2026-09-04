/**
 * Allowlisted Open-Meteo importer for a live read-only decision dataset.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FailureScenario } from "../../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";
import { validateScenario } from "../../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";
import { fetchBoundedJson, PublicDataImportError, type BoundedFetchOptions } from "./boundedFetch";

const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const COORDINATE_LIMITS = Object.freeze({
  latitude: Object.freeze({ min: -90, max: 90 }),
  longitude: Object.freeze({ min: -180, max: 180 }),
});

interface OpenMeteoCurrent {
  readonly time: string;
  readonly temperature_2m: number;
  readonly wind_speed_10m: number;
  readonly precipitation: number;
}

/** Import one bounded current-weather observation without accepting an arbitrary endpoint. */
export async function importOpenMeteoScenario(
  latitude: number,
  longitude: number,
  options: BoundedFetchOptions = {},
): Promise<FailureScenario> {
  assertCoordinate(latitude, "latitude", COORDINATE_LIMITS.latitude);
  assertCoordinate(longitude, "longitude", COORDINATE_LIMITS.longitude);
  const url = new URL(OPEN_METEO_ENDPOINT);
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,wind_speed_10m,precipitation",
    timezone: "UTC",
  }).toString();
  const value = await fetchBoundedJson(url, options);
  const current = parseCurrent(value);
  const coordinateId = `${safeCoordinate(latitude)}-${safeCoordinate(longitude)}`;

  return validateScenario({
    version: 1,
    id: `open-meteo-${coordinateId}`,
    title: "Can this live weather observation pass a read-only evidence gate?",
    summary: "Import current public measurements and evaluate them through the same bounded policy contract.",
    source: {
      kind: "open_meteo",
      label: `Open-Meteo ${latitude}, ${longitude}`,
      reference: "https://open-meteo.com/en/docs",
    },
    policy: {
      minConfidence: 0.95,
      minEvidenceReferences: 3,
      deadlineMs: 2_000,
      retryLimit: 0,
      maxEvidenceAttempts: 4,
    },
    candidates: [{
      id: "open-meteo-current",
      name: "Open-Meteo current observation",
      latencyMs: 0,
      outcomes: [{
        type: "success",
        confidence: 0.99,
        evidence: [
          `weather:temperature_2m:${current.temperature_2m}`,
          `weather:wind_speed_10m:${current.wind_speed_10m}`,
          `weather:precipitation:${current.precipitation}`,
          `weather:observed_at:${truncate(current.time)}`,
        ],
        action: "record_weather_observation",
        risk: "read_only",
      }],
    }],
  });
}

function parseCurrent(value: unknown): OpenMeteoCurrent {
  if (!isRecord(value) || !isRecord(value.current)) {
    throw new PublicDataImportError("invalid_response", "Open-Meteo returned no current observation.");
  }
  const current = value.current;
  if (typeof current.time !== "string"
    || !isFiniteNumber(current.temperature_2m)
    || !isFiniteNumber(current.wind_speed_10m)
    || !isFiniteNumber(current.precipitation)) {
    throw new PublicDataImportError("invalid_response", "Open-Meteo returned an invalid current observation.");
  }
  return current as unknown as OpenMeteoCurrent;
}

function assertCoordinate(
  value: number,
  name: "latitude" | "longitude",
  limits: Readonly<{ min: number; max: number }>,
): void {
  if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new RangeError(`${name} must be between ${limits.min} and ${limits.max}.`);
  }
}

function safeCoordinate(value: number): string {
  return String(value).replace("-", "n").replace(".", "p");
}

function truncate(value: string): string {
  return value.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "unknown";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
