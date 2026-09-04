/**
 * User-controlled entry points for allowlisted public-data imports.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { CloudDownload, GitBranch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FailureScenario } from "../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";
import {
  GITHUB_REPOSITORIES,
  importGitHubIssuesScenario,
  type GitHubRepository,
} from "./public-data/githubIssues";
import { importOpenMeteoScenario } from "./public-data/openMeteo";

type ImportState = "idle" | "loading";

export interface PublicDataImportersProps {
  readonly onImport: (scenario: FailureScenario) => void;
}

/** Render explicit, cancellable imports from two public-data allowlists. */
export function PublicDataImporters({ onImport }: PublicDataImportersProps) {
  const [repository, setRepository] = useState<GitHubRepository>(GITHUB_REPOSITORIES[0]);
  const [latitude, setLatitude] = useState(-25.97);
  const [longitude, setLongitude] = useState(32.59);
  const [state, setState] = useState<ImportState>("idle");
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function runImport(load: (signal: AbortSignal) => Promise<FailureScenario>) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState("loading");
    setError(null);
    try {
      onImport(await load(controller.signal));
    } catch (caught) {
      if (!controller.signal.aborted) setError(readError(caught));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setState("idle");
      }
    }
  }

  return (
    <section className="grid gap-3 rounded-md border border-zinc-200 bg-[#fbfcf8] p-3">
      <div>
        <h3 className="text-sm font-black">Import live public data</h3>
        <p className="mt-1 text-xs leading-5 text-zinc-600">
          GET-only, no tokens, no custom URLs. Imports become editable datasets; they do not execute provider code.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <select
          aria-label="Allowlisted GitHub repository"
          className="h-10 min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-xs font-bold"
          value={repository}
          disabled={state === "loading"}
          onChange={(event) => setRepository(event.target.value as GitHubRepository)}
        >
          {GITHUB_REPOSITORIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button
          className="command-button justify-center border border-zinc-300 bg-white text-zinc-950 disabled:opacity-50"
          type="button"
          disabled={state === "loading"}
          onClick={() => void runImport((signal) => importGitHubIssuesScenario(repository, { signal }))}
        >
          <GitBranch className="h-4 w-4" aria-hidden="true" />
          Import issues
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <CoordinateInput label="Latitude" value={latitude} min={-90} max={90} onChange={setLatitude} />
        <CoordinateInput label="Longitude" value={longitude} min={-180} max={180} onChange={setLongitude} />
        <button
          className="command-button justify-center border border-zinc-300 bg-white text-zinc-950 disabled:opacity-50 sm:self-end"
          type="button"
          disabled={state === "loading"}
          onClick={() => void runImport((signal) => importOpenMeteoScenario(latitude, longitude, { signal }))}
        >
          <CloudDownload className="h-4 w-4" aria-hidden="true" />
          Import weather
        </button>
      </div>

      {state === "loading" ? <p className="text-xs font-bold text-zinc-600">Importing bounded public data…</p> : null}
      {error === null ? null : <p role="alert" className="text-xs font-bold text-[#7d241c]">{error}</p>}
    </section>
  );
}

function CoordinateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-[0.68rem] font-black uppercase tracking-[0.06em] text-zinc-500">
      {label}
      <input
        className="h-10 min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-xs font-bold text-zinc-950"
        type="number"
        min={min}
        max={max}
        step="0.01"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function readError(value: unknown): string {
  return value instanceof Error ? value.message : "Public data import failed.";
}
