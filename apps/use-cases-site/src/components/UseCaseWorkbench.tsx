/**
 * WorkIt example workbench.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { Activity, CheckCircle2, ShieldCheck, TimerReset } from "lucide-react";
import { useState } from "react";
import { CodePathPanel } from "./CodePathPanel";
import { EvidenceLedger } from "./EvidenceLedger";
import { ExampleDetails } from "./ExampleDetails";
import { LogList } from "./LogList";
import { RuntimeTree } from "./RuntimeTree";
import { RunInspector } from "./RunInspector";
import { Panel, ProblemPanel } from "./Panels";
import { SegmentedTabs } from "./SegmentedTabs";
import type { ExampleRunResult, RunPhase, UseCase } from "../types";

type MobileLabTab = "runtime" | "code" | "logs";

const phaseLabel: Record<RunPhase, string> = {
  idle: "Ready",
  running: "Running",
  completed: "Completed",
  aborted: "Aborted",
};

const mobileLabTabs: Array<{ id: MobileLabTab; label: string }> = [
  { id: "runtime", label: "Runtime" },
  { id: "code", label: "Code" },
  { id: "logs", label: "Logs" },
];

export interface UseCaseWorkbenchProps {
  selected: UseCase;
  phase: RunPhase;
  runStep: number;
  runResult: ExampleRunResult | null;
  onRun: () => void;
  onAbort: () => void;
  onReset: () => void;
}

/** Render the selected example, runtime workbench, and supporting sections. */
export function UseCaseWorkbench({
  selected,
  phase,
  runStep,
  runResult,
  onRun,
  onAbort,
  onReset,
}: UseCaseWorkbenchProps) {
  const [mobileTab, setMobileTab] = useState<MobileLabTab>("code");
  const events = runResult?.events ?? selected.events[phase];
  const receipt = runResult?.receipt ?? selected.receipt[phase];
  const code = runResult?.code ?? selected.code;
  const runSource = runResult?.source ?? "captured-build";

  return (
    <section className="grid min-w-0 gap-4">
      <div className="min-w-0 border border-zinc-200 bg-white p-4 sm:p-5" style={{ borderRadius: 8 }}>
        <div className="grid min-w-0 gap-4">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-zinc-200 bg-[#fbfcf8] px-3 py-2 text-xs font-black uppercase tracking-[0.08em] text-zinc-500">
                {selected.audience}
              </span>
              <span className="rounded-md border border-[#9bd2bf] bg-[#f0fbf6] px-3 py-2 text-xs font-black uppercase tracking-[0.08em] text-[#174a39]">
                {phaseLabel[phase]}
              </span>
            </div>
            <h2 className="max-w-full break-words text-3xl font-black leading-tight sm:text-4xl">{selected.title}</h2>
            <p className="max-w-3xl text-base leading-7 text-zinc-650">{selected.summary}</p>
          </div>
        </div>

        <div className="mt-5 hidden gap-4 xl:grid xl:grid-cols-[0.82fr_1.04fr_340px] 2xl:grid-cols-[0.85fr_1.15fr_360px]">
          <Panel title="Live runtime tree" icon={Activity}>
            <RuntimeTree phase={phase} runStep={runStep} nodes={selected.runtimeTree} />
          </Panel>
          <CodePathPanel code={code} onRun={onRun} onAbort={onAbort} onReset={onReset} />
          <RunInspector selected={selected} phase={phase} runSource={runSource} events={visibleLogLines(events, phase, runStep)} receipt={visibleLogLines(receipt, phase, runStep)} />
        </div>

        <div className="mt-5 xl:hidden">
          <SegmentedTabs activeTab={mobileTab} options={mobileLabTabs} onChange={setMobileTab} />
          <div className="mt-3">
            {mobileTab === "runtime" ? (
              <Panel title="Live runtime tree" icon={Activity}>
                <RuntimeTree phase={phase} runStep={runStep} nodes={selected.runtimeTree} />
              </Panel>
            ) : null}
            {mobileTab === "code" ? (
              <CodePathPanel code={code} onRun={onRun} onAbort={onAbort} onReset={onReset} />
            ) : null}
            {mobileTab === "logs" ? (
              <div className="grid min-w-0 gap-3">
                <Panel title="Events" icon={Activity}>
                  <LogList lines={visibleLogLines(events, phase, runStep)} compact />
                </Panel>
                <Panel title="Receipt" icon={CheckCircle2}>
                  <LogList lines={visibleLogLines(receipt, phase, runStep)} compact />
                </Panel>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[1fr_1fr]">
        <ProblemPanel title="Scenario" body={selected.pain} icon={TimerReset} />
        <ProblemPanel title="Feature path" body={selected.answer} icon={ShieldCheck} />
      </div>

      <ExampleDetails selected={selected} />

      <EvidenceLedger items={selected.evidence} />
    </section>
  );
}

function visibleLogLines(lines: string[], phase: RunPhase, runStep: number) {
  if (phase !== "running") {
    return lines;
  }

  return lines.slice(0, Math.max(1, Math.min(lines.length, runStep + 1)));
}
