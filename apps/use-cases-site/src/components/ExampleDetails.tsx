/**
 * Supporting example detail panels.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import clsx from "clsx";
import { Activity, ShieldCheck } from "lucide-react";
import { Panel } from "./Panels";
import type { FeatureTone, UseCase } from "../types";

const toneClasses: Record<FeatureTone, string> = {
  coral: "border-[#f0b1aa] bg-[#fff4f2] text-[#8f2118]",
  emerald: "border-[#9bd2bf] bg-[#f0fbf6] text-[#174a39]",
  amber: "border-[#edcf89] bg-[#fff9ea] text-[#6b3a00]",
  cobalt: "border-[#adc4f6] bg-[#f2f6ff] text-[#243f84]",
  ink: "border-zinc-300 bg-zinc-950 text-white",
};

export interface ExampleDetailsProps {
  selected: UseCase;
}

/** Render user flow and runtime feature mapping for the selected example. */
export function ExampleDetails({ selected }: ExampleDetailsProps) {
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[1fr_1fr]">
      <UserFlowPanel selected={selected} />
      <RuntimeFeaturesPanel selected={selected} />
    </div>
  );
}

function UserFlowPanel({ selected }: ExampleDetailsProps) {
  return (
    <Panel title="User flow" icon={Activity}>
      <div className="grid gap-2">
        {selected.flow.map((step, index) => (
          <div key={`${step.runtimeOwner}-${step.userAction}`} className="grid grid-cols-[32px_1fr] gap-3 border border-zinc-200 bg-[#fbfcf8] p-3" style={{ borderRadius: 8 }}>
            <div className="grid h-8 w-8 place-items-center border border-zinc-300 bg-white text-sm font-black" style={{ borderRadius: 8 }}>
              {index + 1}
            </div>
            <div className="min-w-0">
              <div className="font-bold">{step.userAction}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-sm text-zinc-600">
                <span>{step.runtimeOwner}</span>
                <span className="text-zinc-300">/</span>
                <span>{step.feature}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RuntimeFeaturesPanel({ selected }: ExampleDetailsProps) {
  return (
    <Panel title="Runtime features used" icon={ShieldCheck}>
      <div className="grid gap-2 sm:grid-cols-2">
        {selected.features.map((feature) => (
          <div key={feature.label} className={clsx("border p-3", toneClasses[feature.tone])} style={{ borderRadius: 8 }}>
            <div className="font-black">{feature.label}</div>
            <p className="mt-2 text-sm leading-6">{feature.reason}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}
