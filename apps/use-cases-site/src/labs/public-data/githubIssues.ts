/**
 * Allowlisted GitHub issue metadata importer for incident-policy datasets.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FailureScenario } from "../../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";
import { validateScenario } from "../../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";
import { fetchBoundedJson, PublicDataImportError, type BoundedFetchOptions } from "./boundedFetch";

const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_IMPORTED_ISSUES = 3;
const MAX_LABELS_PER_ISSUE = 3;
const IMPORT_CONFIDENCE = Object.freeze({ labelledBug: 0.9, needsReview: 0.7 });

export const GITHUB_REPOSITORIES = Object.freeze([
  "openai/openai-agents-js",
  "vercel/ai",
  "langchain-ai/langgraph",
] as const);

export type GitHubRepository = typeof GITHUB_REPOSITORIES[number];

interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly state: string;
  readonly labels: ReadonlyArray<string | { readonly name?: unknown }>;
  readonly pull_request?: unknown;
}

/** Import bounded public issue metadata from one curated AI repository. */
export async function importGitHubIssuesScenario(
  repository: GitHubRepository,
  options: BoundedFetchOptions = {},
): Promise<FailureScenario> {
  if (!GITHUB_REPOSITORIES.includes(repository)) {
    throw new PublicDataImportError("invalid_response", "Repository is not in the public-data allowlist.");
  }
  const url = new URL(`/repos/${repository}/issues`, GITHUB_API_ORIGIN);
  url.search = new URLSearchParams({
    state: "open",
    per_page: String(MAX_IMPORTED_ISSUES + 2),
    sort: "updated",
    direction: "desc",
  }).toString();
  const value = await fetchBoundedJson(url, options);
  const issues = parseIssues(value).filter(({ pull_request: pullRequest }) => pullRequest === undefined)
    .slice(0, MAX_IMPORTED_ISSUES);
  if (issues.length === 0) {
    throw new PublicDataImportError("invalid_response", "The selected repository returned no importable issues.");
  }

  return validateScenario({
    version: 1,
    id: `github-${repository.replace("/", "-")}`,
    title: "Can this live AI incident report enter the triage queue?",
    summary: "Apply a deterministic metadata policy to recently updated public issue reports.",
    source: {
      kind: "github_issues",
      label: `GitHub Issues: ${repository}`,
      reference: `https://github.com/${repository}/issues`,
    },
    policy: {
      minConfidence: 0.85,
      minEvidenceReferences: 2,
      deadlineMs: 2_000,
      retryLimit: 0,
      maxEvidenceAttempts: 4,
    },
    candidates: issues.map(toCandidate),
  });
}

function toCandidate(issue: GitHubIssue) {
  const labels = issue.labels.map(readLabel).filter((label): label is string => label !== null)
    .slice(0, MAX_LABELS_PER_ISSUE);
  const isLabelledBug = labels.some((label) => label.toLowerCase().includes("bug"));
  return {
    id: `issue-${issue.number}`,
    name: truncate(`#${issue.number} ${issue.title}`),
    latencyMs: 0,
    outcomes: [{
      type: "success",
      confidence: isLabelledBug ? IMPORT_CONFIDENCE.labelledBug : IMPORT_CONFIDENCE.needsReview,
      evidence: [
        `github:issue:${issue.number}`,
        `github:state:${truncate(issue.state)}`,
        ...labels.map((label) => `github:label:${truncate(label)}`),
      ],
      action: "open_incident_review",
      risk: "read_only",
    }],
  };
}

function parseIssues(value: unknown): GitHubIssue[] {
  if (!Array.isArray(value)) throw new PublicDataImportError("invalid_response", "GitHub returned an invalid issue list.");
  return value.map((issue) => {
    if (!isRecord(issue)
      || !Number.isInteger(issue.number)
      || typeof issue.title !== "string"
      || typeof issue.html_url !== "string"
      || typeof issue.state !== "string"
      || !Array.isArray(issue.labels)) {
      throw new PublicDataImportError("invalid_response", "GitHub returned an invalid issue record.");
    }
    return issue as unknown as GitHubIssue;
  });
}

function readLabel(value: string | { readonly name?: unknown }): string | null {
  if (typeof value === "string") return value;
  return typeof value.name === "string" ? value.name : null;
}

function truncate(value: string): string {
  return value.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "untitled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
