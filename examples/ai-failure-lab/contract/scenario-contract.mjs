/**
 * Bounded, environment-neutral contract for editable WorkIt failure scenarios.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export const SCENARIO_VERSION = 1;

export const SCENARIO_LIMITS = Object.freeze({
  maxBytes: 32_768,
  maxCandidates: 12,
  maxOutcomesPerCandidate: 8,
  maxEvidenceReferences: 8,
  maxEvidenceAttempts: 32,
  maxStringLength: 160,
  maxDeadlineMs: 10_000,
  maxLatencyMs: 5_000,
  maxRetries: 4,
});

const SOURCE_KINDS = new Set(["fixture", "github_issues", "open_meteo"]);
const OUTCOME_TYPES = new Set(["success", "failure"]);
const RISKS = new Set(["read_only", "production_write"]);
const FAILURE_CLASSES = new Set(["transient", "unavailable", "invalid_request"]);
const SLUG_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

const ROOT_KEYS = new Set(["version", "id", "title", "summary", "source", "policy", "candidates"]);
const SOURCE_KEYS = new Set(["kind", "label", "reference"]);
const POLICY_KEYS = new Set([
  "minConfidence",
  "minEvidenceReferences",
  "deadlineMs",
  "retryLimit",
  "maxEvidenceAttempts",
]);
const CANDIDATE_KEYS = new Set(["id", "name", "latencyMs", "outcomes"]);
const SUCCESS_KEYS = new Set(["type", "confidence", "evidence", "action", "risk"]);
const FAILURE_KEYS = new Set(["type", "failureClass"]);

/** Raised when editable scenario data violates a bounded public contract. */
export class ScenarioContractError extends TypeError {
  /** Create a contract error tied to one JSON path. */
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ScenarioContractError";
    this.path = path;
  }
}

/** Parse and validate one user-editable scenario JSON document. */
export function parseScenarioJson(json) {
  if (typeof json !== "string") {
    throw new ScenarioContractError("$", "scenario JSON must be a string");
  }

  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > SCENARIO_LIMITS.maxBytes) {
    throw new ScenarioContractError("$", `scenario exceeds ${SCENARIO_LIMITS.maxBytes} bytes`);
  }

  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ScenarioContractError("$", "scenario must contain valid JSON");
  }

  return validateScenario(value);
}

/** Validate and snapshot one scenario supplied by a fixture or public-data adapter. */
export function validateScenario(value) {
  const root = recordAt(value, "$", ROOT_KEYS);
  integerAt(root.version, "$.version", SCENARIO_VERSION, SCENARIO_VERSION);
  const id = slugAt(root.id, "$.id");
  const title = stringAt(root.title, "$.title");
  const summary = stringAt(root.summary, "$.summary");
  const source = validateSource(root.source);
  const policy = validatePolicy(root.policy);
  const candidates = arrayAt(root.candidates, "$.candidates", 1, SCENARIO_LIMITS.maxCandidates)
    .map((candidate, index) => validateCandidate(candidate, index));
  uniqueCandidateIds(candidates);

  return deepFreeze({
    version: SCENARIO_VERSION,
    id,
    title,
    summary,
    source,
    policy,
    candidates,
  });
}

function validateSource(value) {
  const source = recordAt(value, "$.source", SOURCE_KEYS);
  const kind = enumAt(source.kind, "$.source.kind", SOURCE_KINDS);
  const label = stringAt(source.label, "$.source.label");
  const reference = optionalStringAt(source.reference, "$.source.reference");
  return {
    kind,
    label,
    ...(reference === undefined ? {} : { reference }),
  };
}

function validatePolicy(value) {
  const policy = recordAt(value, "$.policy", POLICY_KEYS);
  return {
    minConfidence: numberAt(policy.minConfidence, "$.policy.minConfidence", 0, 1),
    minEvidenceReferences: integerAt(
      policy.minEvidenceReferences,
      "$.policy.minEvidenceReferences",
      0,
      SCENARIO_LIMITS.maxEvidenceReferences,
    ),
    deadlineMs: integerAt(policy.deadlineMs, "$.policy.deadlineMs", 100, SCENARIO_LIMITS.maxDeadlineMs),
    retryLimit: integerAt(policy.retryLimit, "$.policy.retryLimit", 0, SCENARIO_LIMITS.maxRetries),
    maxEvidenceAttempts: integerAt(
      policy.maxEvidenceAttempts,
      "$.policy.maxEvidenceAttempts",
      1,
      SCENARIO_LIMITS.maxEvidenceAttempts,
    ),
  };
}

function validateCandidate(value, index) {
  const path = `$.candidates[${index}]`;
  const candidate = recordAt(value, path, CANDIDATE_KEYS);
  const outcomes = arrayAt(
    candidate.outcomes,
    `${path}.outcomes`,
    1,
    SCENARIO_LIMITS.maxOutcomesPerCandidate,
  ).map((outcome, outcomeIndex) => validateOutcome(outcome, `${path}.outcomes[${outcomeIndex}]`));

  return {
    id: slugAt(candidate.id, `${path}.id`),
    name: stringAt(candidate.name, `${path}.name`),
    latencyMs: integerAt(candidate.latencyMs, `${path}.latencyMs`, 0, SCENARIO_LIMITS.maxLatencyMs),
    outcomes,
  };
}

function validateOutcome(value, path) {
  const candidate = recordAt(value, path);
  const type = enumAt(candidate.type, `${path}.type`, OUTCOME_TYPES);
  return type === "success"
    ? validateSuccess(candidate, path)
    : validateFailure(candidate, path);
}

function validateSuccess(value, path) {
  assertKnownKeys(value, path, SUCCESS_KEYS);
  return {
    type: "success",
    confidence: numberAt(value.confidence, `${path}.confidence`, 0, 1),
    evidence: arrayAt(
      value.evidence,
      `${path}.evidence`,
      0,
      SCENARIO_LIMITS.maxEvidenceReferences,
    ).map((reference, index) => stringAt(reference, `${path}.evidence[${index}]`)),
    action: slugAt(value.action, `${path}.action`),
    risk: enumAt(value.risk, `${path}.risk`, RISKS),
  };
}

function validateFailure(value, path) {
  assertKnownKeys(value, path, FAILURE_KEYS);
  return {
    type: "failure",
    failureClass: enumAt(value.failureClass, `${path}.failureClass`, FAILURE_CLASSES),
  };
}

function uniqueCandidateIds(candidates) {
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      throw new ScenarioContractError("$.candidates", `duplicate candidate id ${candidate.id}`);
    }
    seen.add(candidate.id);
  }
}

function recordAt(value, path, allowedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScenarioContractError(path, "must be an object");
  }
  if (allowedKeys !== undefined) assertKnownKeys(value, path, allowedKeys);
  return value;
}

function assertKnownKeys(value, path, allowedKeys) {
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new ScenarioContractError(`${path}.${unknown}`, "unknown fields are not allowed");
  }
}

function arrayAt(value, path, minLength, maxLength) {
  if (!Array.isArray(value)) throw new ScenarioContractError(path, "must be an array");
  if (value.length < minLength || value.length > maxLength) {
    throw new ScenarioContractError(path, `must contain between ${minLength} and ${maxLength} items`);
  }
  return value;
}

function stringAt(value, path) {
  if (typeof value !== "string" || value.length < 1 || value.length > SCENARIO_LIMITS.maxStringLength) {
    throw new ScenarioContractError(path, `must be a non-empty string up to ${SCENARIO_LIMITS.maxStringLength} characters`);
  }
  return value;
}

function optionalStringAt(value, path) {
  return value === undefined ? undefined : stringAt(value, path);
}

function slugAt(value, path) {
  const text = stringAt(value, path);
  if (!SLUG_PATTERN.test(text)) throw new ScenarioContractError(path, "must be a lowercase slug");
  return text;
}

function enumAt(value, path, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new ScenarioContractError(path, `must be one of ${[...allowed].join(", ")}`);
  }
  return value;
}

function integerAt(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ScenarioContractError(path, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function numberAt(value, path, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ScenarioContractError(path, `must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return value;
}
