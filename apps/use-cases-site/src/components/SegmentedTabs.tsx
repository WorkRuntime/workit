/**
 * Small segmented tab control.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import clsx from "clsx";

export interface SegmentedTabOption<T extends string> {
  id: T;
  label: string;
}

export interface SegmentedTabsProps<T extends string> {
  activeTab: T;
  options: Array<SegmentedTabOption<T>>;
  onChange: (tab: T) => void;
}

/** Render a compact, fixed-width tab selector. */
export function SegmentedTabs<T extends string>({ activeTab, options, onChange }: SegmentedTabsProps<T>) {
  return (
    <div className="grid grid-cols-3 border border-zinc-200 bg-[#fbfcf8] p-1" style={{ borderRadius: 8 }}>
      {options.map((tab) => (
        <button
          key={tab.id}
          className={clsx(
            "min-h-10 rounded-md px-3 text-sm font-black transition",
            activeTab === tab.id ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-white hover:text-zinc-950",
          )}
          type="button"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
