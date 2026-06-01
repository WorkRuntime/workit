/**
 * Evidence ledger view for example source paths and invariants.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { BookOpen } from "lucide-react";
import { Panel } from "./Panels";
import type { EvidenceItem } from "../types";

export interface EvidenceLedgerProps {
  items: EvidenceItem[];
}

/** Render tracked source paths and the invariants they exercise. */
export function EvidenceLedger({ items }: EvidenceLedgerProps) {
  return (
    <Panel title="Evidence ledger" icon={BookOpen} id="evidence">
      <div className="grid gap-3 lg:grid-cols-2">
        {items.map((item) => (
          <div key={item.claim} className="border border-zinc-200 bg-[#fbfcf8] p-4" style={{ borderRadius: 8 }}>
            <div className="text-xs font-black uppercase tracking-[0.08em] text-[#226f54]">{item.status}</div>
            <div className="mt-2 font-black">{item.claim}</div>
            <div className="mt-3 grid gap-2 text-sm leading-6 text-zinc-650">
              <div><span className="font-bold text-zinc-950">Path:</span> {item.path}</div>
              <div><span className="font-bold text-zinc-950">Invariant:</span> {item.invariant}</div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
