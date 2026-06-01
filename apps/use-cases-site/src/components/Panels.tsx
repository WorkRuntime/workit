/**
 * Reusable panel primitives for WorkIt example surfaces.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface PanelProps {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  id?: string;
}

/** Render a bordered section with a compact icon heading. */
export function Panel({ title, icon: Icon, children, id }: PanelProps) {
  return (
    <section id={id} className="min-w-0 border border-zinc-200 bg-white p-4 sm:p-5" style={{ borderRadius: 8 }}>
      <div className="mb-4 flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center border border-zinc-200 bg-[#fbfcf8]" style={{ borderRadius: 8 }}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <h3 className="text-lg font-black">{title}</h3>
      </div>
      {children}
    </section>
  );
}

export interface ProblemPanelProps {
  title: string;
  body: string;
  icon: LucideIcon;
}

/** Render an explanatory text panel below the live workbench. */
export function ProblemPanel({ title, body, icon: Icon }: ProblemPanelProps) {
  return (
    <div className="border border-zinc-200 bg-[#fbfcf8] p-4" style={{ borderRadius: 8 }}>
      <div className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.08em] text-zinc-500">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {title}
      </div>
      <p className="mt-3 text-base leading-7 text-zinc-700">{body}</p>
    </div>
  );
}
