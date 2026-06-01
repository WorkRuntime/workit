/**
 * Bounded log line renderer for runtime events and receipts.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import clsx from "clsx";

export interface LogListProps {
  lines: string[];
  variant?: "light" | "dark";
  compact?: boolean;
}

/** Render repeated log lines with stable stream-order keys. */
export function LogList({ lines, variant = "light", compact = false }: LogListProps) {
  return (
    <div className={clsx("grid", compact ? "gap-1.5" : "gap-2")}>
      {lines.map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={clsx(
            "grid grid-cols-[10px_1fr] items-center gap-3 border px-3 py-2 font-mono text-sm",
            compact ? "text-xs leading-5" : "",
            variant === "dark"
              ? "border-white/10 bg-black/20 text-zinc-100"
              : "border-zinc-200 bg-[#fbfcf8] text-zinc-800",
          )}
          style={{ borderRadius: 8 }}
        >
          <span className={clsx("h-2.5 w-2.5 rounded-sm", variant === "dark" ? "bg-[#edcf89]" : "bg-[#226f54]")} />
          <span className="min-w-0 break-words">{line}</span>
        </div>
      ))}
    </div>
  );
}
