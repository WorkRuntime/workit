/**
 * Trust-labelled rendering for deterministic policy preview results.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { AlertTriangle, CheckCircle2, Clock3, ShieldAlert } from "lucide-react";
import type { ScenarioPreviewResult } from "../../../../examples/ai-failure-lab/policy/preview-engine.mjs";

const statusPresentation = {
  accepted: { label: "Accepted", icon: CheckCircle2, className: "border-[#7bcaae] bg-[#ecfaf4] text-[#174a39]" },
  exhausted: { label: "Exhausted", icon: AlertTriangle, className: "border-[#edcf89] bg-[#fff9e9] text-[#6d4b00]" },
  terminal: { label: "Terminal stop", icon: ShieldAlert, className: "border-[#e9a29a] bg-[#fff2f0] text-[#7d241c]" },
  requires_user_input: { label: "Operator required", icon: ShieldAlert, className: "border-[#e9a29a] bg-[#fff2f0] text-[#7d241c]" },
} as const;

export interface PreviewResultProps {
  readonly result: ScenarioPreviewResult;
}

/** Render bounded decision evidence without implying real runtime execution. */
export function PreviewResult({ result }: PreviewResultProps) {
  const presentation = statusPresentation[result.status];
  const StatusIcon = presentation.icon;

  return (
    <section className="grid min-w-0 gap-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-black uppercase tracking-[0.08em] ${presentation.className}`}>
          <StatusIcon className="h-4 w-4" aria-hidden="true" />
          {presentation.label}
        </span>
        <span className="inline-flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.08em] text-zinc-600">
          <Clock3 className="h-4 w-4" aria-hidden="true" />
          {result.elapsedMs} ms modeled
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <Fact label="Candidate" value={result.candidateId ?? "none"} />
        <Fact label="Action" value={result.action ?? "none"} />
        <Fact label="Retries" value={`${result.retryBudget.spent}/${result.retryBudget.limit ?? 0}`} />
        <Fact label="Dropped evidence" value={String(result.droppedEvidence)} />
      </dl>

      <div className="min-w-0 overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.06em] text-zinc-500">
            <tr>
              <th className="border-b border-zinc-200 px-3 py-2">Candidate</th>
              <th className="border-b border-zinc-200 px-3 py-2">Attempt</th>
              <th className="border-b border-zinc-200 px-3 py-2">Decision</th>
              <th className="border-b border-zinc-200 px-3 py-2">Reason</th>
              <th className="border-b border-zinc-200 px-3 py-2">Elapsed</th>
            </tr>
          </thead>
          <tbody>
            {result.evidence.map((attempt, index) => (
              <tr key={`${attempt.candidateId}-${attempt.attempt}-${index}`} className="align-top">
                <td className="border-b border-zinc-100 px-3 py-3 font-bold">{attempt.candidateId}</td>
                <td className="border-b border-zinc-100 px-3 py-3">{attempt.attempt}</td>
                <td className="border-b border-zinc-100 px-3 py-3 font-mono text-xs">{attempt.decision}</td>
                <td className="border-b border-zinc-100 px-3 py-3 font-mono text-xs text-zinc-600">{attempt.reasonCode ?? "—"}</td>
                <td className="border-b border-zinc-100 px-3 py-3">{attempt.elapsedMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-zinc-200 bg-[#fbfcf8] p-3">
      <dt className="text-[0.68rem] font-black uppercase tracking-[0.08em] text-zinc-500">{label}</dt>
      <dd className="mt-1 truncate font-mono text-xs font-bold text-zinc-900" title={value}>{value}</dd>
    </div>
  );
}
