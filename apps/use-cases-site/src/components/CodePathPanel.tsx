/**
 * Source code panel with compact runtime controls.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { Braces, Play, RotateCcw, Square } from "lucide-react";

export interface CodePathPanelProps {
  code: string;
  onRun: () => void;
  onAbort: () => void;
  onReset: () => void;
}

/** Render source code and small command buttons in the panel header. */
export function CodePathPanel({ code, onRun, onAbort, onReset }: CodePathPanelProps) {
  return (
    <section className="min-w-0 border border-zinc-200 bg-white p-4 sm:p-5" style={{ borderRadius: 8 }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center border border-zinc-200 bg-[#fbfcf8]" style={{ borderRadius: 8 }}>
            <Braces className="h-4 w-4" aria-hidden="true" />
          </div>
          <h3 className="text-lg font-black">Code path</h3>
        </div>
        <CodeToolbar onRun={onRun} onAbort={onAbort} onReset={onReset} />
      </div>
      <pre className="max-h-[480px] min-h-[340px] w-full min-w-0 overflow-auto border border-zinc-800 bg-zinc-950 p-4 text-sm leading-6 text-zinc-100" style={{ borderRadius: 8 }}>
        <code>{code}</code>
      </pre>
    </section>
  );
}

function CodeToolbar({
  onRun,
  onAbort,
  onReset,
}: {
  onRun: () => void;
  onAbort: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button className="code-command-button bg-zinc-950 text-white" type="button" onClick={onRun}>
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
        Run
      </button>
      <button className="code-command-button border border-[#f0b1aa] bg-[#fff4f2] text-[#8f2118]" type="button" onClick={onAbort}>
        <Square className="h-3.5 w-3.5" aria-hidden="true" />
        Abort
      </button>
      <button className="code-command-button border border-zinc-200 bg-white text-zinc-950" type="button" onClick={onReset}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        Reset
      </button>
    </div>
  );
}
