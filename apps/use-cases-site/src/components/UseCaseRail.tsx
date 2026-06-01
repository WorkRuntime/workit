/**
 * Example selector rail for the WorkIt examples site.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import { useCases } from "../data/useCases";
import type { UseCase } from "../types";

export interface UseCaseRailProps {
  selectedId: string;
  onSelect: (useCase: UseCase) => void;
}

/** Render the selectable list of real WorkIt examples. */
export function UseCaseRail({ selectedId, onSelect }: UseCaseRailProps) {
  return (
    <aside id="use-cases" className="h-fit border border-zinc-200 bg-white p-2" style={{ borderRadius: 8 }}>
      <div className="px-3 py-3 text-xs font-black uppercase tracking-[0.08em] text-zinc-500">Examples</div>
      <div className="grid gap-2">
        {useCases.map((useCase) => (
          <button
            key={useCase.id}
            className={clsx(
              "group grid w-full grid-cols-[1fr_auto] items-center gap-3 border p-3 text-left transition",
              selectedId === useCase.id
                ? "border-zinc-950 bg-zinc-950 text-white"
                : "border-zinc-200 bg-[#fbfcf8] text-zinc-950 hover:border-zinc-400",
            )}
            style={{ borderRadius: 8 }}
            type="button"
            onClick={() => onSelect(useCase)}
          >
            <span className="min-w-0">
              <span className="block truncate font-bold">{useCase.title}</span>
              <span className={clsx("mt-1 block text-sm", selectedId === useCase.id ? "text-zinc-300" : "text-zinc-500")}>
                {useCase.audience}
              </span>
            </span>
            <ArrowRight className="h-4 w-4 opacity-60 transition group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        ))}
      </div>
    </aside>
  );
}
