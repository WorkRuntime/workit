/**
 * Runtime event and receipt inspector.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { Activity, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import { LogList } from "./LogList";
import type { ExampleRunResult, RunPhase, UseCase } from "../types";

const phaseLabel: Record<RunPhase, string> = {
  idle: "Ready",
  running: "Running",
  completed: "Completed",
  aborted: "Aborted",
};

export interface RunInspectorProps {
  selected: UseCase;
  phase: RunPhase;
  runSource: ExampleRunResult["source"];
  events: string[];
  receipt: string[];
}

/** Render the current runtime result without changing the workbench height. */
export function RunInspector({ selected, phase, runSource, events, receipt }: RunInspectorProps) {
  return (
    <aside
      aria-label="Run inspector"
      data-testid="run-inspector"
      className="grid max-h-[568px] min-w-0 self-start gap-3 overflow-y-auto overscroll-contain border border-zinc-950 bg-zinc-950 p-4 text-white shadow-[0_18px_50px_rgba(18,22,25,0.16)] [scrollbar-gutter:stable]"
      style={{ borderRadius: 8 }}
    >
      <div>
        <div className="text-xs font-black uppercase tracking-[0.08em] text-[#edcf89]">Run inspector</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-white/15 bg-white/10 px-3 py-2 text-xs font-black uppercase tracking-[0.08em]">
            {phaseLabel[phase]}
          </span>
          <span className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-xs font-black uppercase tracking-[0.08em] text-zinc-300">
            {selected.audience}
          </span>
          <span className={clsx(
            "rounded-md border px-3 py-2 text-xs font-black uppercase tracking-[0.08em]",
            runSource === "live-node"
              ? "border-[#9bd2bf] bg-[#12382b] text-[#b8f4dc]"
              : "border-[#edcf89]/50 bg-[#3f3215] text-[#ffe7aa]",
          )}>
            {runSource === "live-node" ? "Node runtime" : "Captured"}
          </span>
        </div>
      </div>

      <InspectorSection title="Events" icon={Activity}>
        <LogList lines={events} variant="dark" compact />
      </InspectorSection>

      <InspectorSection title="Receipt" icon={CheckCircle2}>
        <LogList lines={receipt} variant="dark" compact />
      </InspectorSection>

      <div className="border-l-4 border-[#e35f4f] pl-3 text-xs leading-5 text-zinc-300">
        Source: {selected.primarySample}
      </div>
    </aside>
  );
}

function InspectorSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 border border-white/15 bg-white/[0.06] p-3" style={{ borderRadius: 8 }}>
      <div className="mb-3 flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center border border-white/15 bg-white/10" style={{ borderRadius: 8 }}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <h3 className="text-sm font-black uppercase tracking-[0.08em]">{title}</h3>
      </div>
      {children}
    </section>
  );
}
