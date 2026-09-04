/**
 * Editable incident policy controls for validated scenario drafts.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ScenarioPolicy } from "../../../../examples/ai-failure-lab/contract/scenario-contract.mjs";

export type EditablePolicyField = keyof Pick<
  ScenarioPolicy,
  "minConfidence" | "minEvidenceReferences" | "deadlineMs" | "retryLimit" | "maxEvidenceAttempts"
>;

interface PolicyControlDefinition {
  readonly field: EditablePolicyField;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

const policyControls: readonly PolicyControlDefinition[] = Object.freeze([
  { field: "minConfidence", label: "Min confidence", min: 0, max: 1, step: 0.01 },
  { field: "minEvidenceReferences", label: "Evidence refs", min: 0, max: 8, step: 1 },
  { field: "deadlineMs", label: "Deadline ms", min: 100, max: 10_000, step: 50 },
  { field: "retryLimit", label: "Retry budget", min: 0, max: 4, step: 1 },
  { field: "maxEvidenceAttempts", label: "Evidence cap", min: 1, max: 32, step: 1 },
]);

export interface PolicyControlsProps {
  readonly policy: ScenarioPolicy | null;
  readonly onChange: (field: EditablePolicyField, value: number) => void;
}

/** Render policy inputs without owning policy evaluation. */
export function PolicyControls({ policy, onChange }: PolicyControlsProps) {
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" disabled={policy === null}>
      <legend className="sr-only">Scenario policy</legend>
      {policyControls.map((control) => (
        <label className="grid gap-1.5 text-xs font-black uppercase tracking-[0.06em] text-zinc-500" key={control.field}>
          {control.label}
          <input
            className="h-11 min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-sm font-bold text-zinc-950 disabled:bg-zinc-100"
            type="number"
            min={control.min}
            max={control.max}
            step={control.step}
            value={policy?.[control.field] ?? ""}
            onChange={(event) => onChange(control.field, Number(event.target.value))}
          />
        </label>
      ))}
    </fieldset>
  );
}
