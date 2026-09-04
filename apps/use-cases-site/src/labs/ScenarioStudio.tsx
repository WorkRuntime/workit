/**
 * Editable AI incident scenario studio with an explicitly modelled preview.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { Braces, ExternalLink, FlaskConical, Play, RotateCcw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import type { FailureScenario } from "../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";
import { parseScenarioJson } from "../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";
import {
  REAL_WORKIT_LAUNCH_URL,
  WORKIT_RUNTIME_VERSION,
} from "../../../../examples/ai-failure-lab/launch-targets.mjs";
import type { ScenarioPreviewResult } from "../../../../examples/ai-failure-lab/policy/preview-engine.mjs";
import { previewScenario } from "../../../../examples/ai-failure-lab/policy/preview-engine.mjs";
import { PolicyControls, type EditablePolicyField } from "./PolicyControls";
import { PreviewResult } from "./PreviewResult";
import { PublicDataImporters } from "./PublicDataImporters";
import { defaultScenarioPreset, scenarioPresets } from "./scenarioPresets";

const presetById = new Map(scenarioPresets.map((preset) => [preset.id, preset]));

/** Render the public scenario editor and deterministic browser policy model. */
export function ScenarioStudio() {
  const [presetId, setPresetId] = useState(defaultScenarioPreset.id);
  const [draft, setDraft] = useState(() => normalizeJson(defaultScenarioPreset.json));
  const [result, setResult] = useState<ScenarioPreviewResult>(() => previewScenario(parseScenarioJson(defaultScenarioPreset.json)));
  const [error, setError] = useState<string | null>(null);
  const parsedDraft = useMemo(() => safelyParse(draft), [draft]);

  function selectPreset(id: string) {
    const preset = presetById.get(id) ?? defaultScenarioPreset;
    const normalized = normalizeJson(preset.json);
    setPresetId(preset.id);
    setDraft(normalized);
    preview(normalized);
  }

  function updatePolicy(field: EditablePolicyField, value: number) {
    if (parsedDraft === null) return;
    const mutable = JSON.parse(JSON.stringify(parsedDraft)) as FailureScenario;
    Object.assign(mutable.policy, { [field]: value });
    const nextDraft = JSON.stringify(mutable, null, 2);
    setDraft(nextDraft);
    preview(nextDraft);
  }

  function preview(json = draft) {
    try {
      const scenario = parseScenarioJson(json);
      setResult(previewScenario(scenario));
      setError(null);
    } catch (caught) {
      setError(readError(caught));
    }
  }

  function reset() {
    selectPreset(presetId);
  }

  function importScenario(scenario: FailureScenario) {
    const json = JSON.stringify(scenario, null, 2);
    setDraft(json);
    setResult(previewScenario(scenario));
    setError(null);
  }

  return (
    <section id="failure-lab" className="mx-auto w-full max-w-[1600px] px-4 pt-6 sm:px-6 lg:px-8">
      <div className="overflow-hidden rounded-lg border border-zinc-950 bg-zinc-950 text-white shadow-[0_24px_80px_rgba(18,22,25,0.14)]">
        <div className="grid gap-5 border-b border-white/10 p-5 lg:grid-cols-[1fr_auto] lg:items-end lg:p-7">
          <div className="max-w-4xl">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-[#7ee0bb]">
              <FlaskConical className="h-4 w-4" aria-hidden="true" />
              WorkIt AI Failure Lab
            </div>
            <h1 className="mt-3 text-3xl font-black leading-tight sm:text-5xl">
              The model wants to roll back production. Should it?
            </h1>
            <p className="mt-3 max-w-3xl text-base leading-7 text-zinc-300">
              Edit the incident dataset and execution policy. The browser models the decision path without making network calls or claiming Node runtime execution.
            </p>
          </div>
          <div className="rounded-md border border-[#edcf89]/40 bg-[#3a2d13] px-4 py-3 text-xs leading-5 text-[#ffe7aa]">
            <strong className="block uppercase tracking-[0.08em]">Policy preview</strong>
            Deterministic browser model — not a WorkIt runtime run.
          </div>
        </div>

        <div className="grid gap-4 bg-[#f7f8f4] p-4 text-zinc-950 lg:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.1fr)] lg:p-5">
          <section className="grid min-w-0 content-start gap-4 rounded-md border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid min-w-[220px] flex-1 gap-1.5 text-xs font-black uppercase tracking-[0.06em] text-zinc-500">
                Scenario
                <select
                  className="h-11 rounded-md border border-zinc-300 bg-white px-3 text-sm font-bold text-zinc-950"
                  value={presetId}
                  onChange={(event) => selectPreset(event.target.value)}
                >
                  {scenarioPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.label}</option>
                  ))}
                </select>
              </label>
              <button className="command-button border border-zinc-300 bg-white text-zinc-950" type="button" onClick={reset}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Reset
              </button>
            </div>

            <PolicyControls policy={parsedDraft?.policy ?? null} onChange={updatePolicy} />

            <PublicDataImporters onImport={importScenario} />

            <label className="grid min-w-0 gap-2 text-xs font-black uppercase tracking-[0.06em] text-zinc-500">
              <span className="flex items-center gap-2"><Braces className="h-4 w-4" aria-hidden="true" /> Editable dataset</span>
              <textarea
                aria-label="Editable incident dataset"
                className="min-h-[420px] w-full resize-y rounded-md border border-zinc-300 bg-[#111315] p-4 font-mono text-xs leading-5 text-zinc-100 outline-none focus:border-[#49c995]"
                spellCheck={false}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>

            {error === null ? null : (
              <div role="alert" className="rounded-md border border-[#e9a29a] bg-[#fff2f0] p-3 font-mono text-xs leading-5 text-[#7d241c]">
                {error}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <button className="command-button justify-center bg-[#49c995] text-[#06291c]" type="button" onClick={() => preview()}>
                <Play className="h-4 w-4" aria-hidden="true" />
                Validate and preview
              </button>
              <a
                className="command-button justify-center border border-zinc-950 bg-white text-zinc-950 no-underline"
                href={REAL_WORKIT_LAUNCH_URL}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Run real WorkIt in Codespaces
              </a>
            </div>
            <p className="text-xs leading-5 text-zinc-500">
              Opens a real Linux Node environment, installs the locked project, runs its parity tests, then executes the tracked dataset with the published <code>@workit/core@{WORKIT_RUNTIME_VERSION}</code>. A GitHub account and available Codespaces quota are required.
            </p>
          </section>

          <section className="min-w-0 rounded-md border border-zinc-200 bg-white p-4 sm:p-5">
            <div className="mb-4 flex items-start gap-3 border-b border-zinc-200 pb-4">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[#9bd2bf] bg-[#f0fbf6] text-[#174a39]">
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-xl font-black">Decision evidence</h2>
                <p className="mt-1 text-sm leading-6 text-zinc-600">
                  Quality, retry, deadline and authority decisions are bounded and visible. No provider is contacted in preview mode.
                </p>
              </div>
            </div>
            <PreviewResult result={result} />
          </section>
        </div>
      </div>
    </section>
  );
}

function normalizeJson(json: string): string {
  return JSON.stringify(JSON.parse(json), null, 2);
}

function safelyParse(json: string): FailureScenario | null {
  try {
    return parseScenarioJson(json);
  } catch {
    return null;
  }
}

function readError(value: unknown): string {
  return value instanceof Error ? value.message : "Scenario validation failed.";
}
