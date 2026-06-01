/**
 * Runtime tree renderer for WorkIt-owned task lifecycles.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { CheckCircle2, CircleDashed, OctagonX, PlayCircle, XCircle } from "lucide-react";
import type { NodeStatus, RunPhase, RuntimeNode } from "../types";

const statusClasses: Record<NodeStatus, string> = {
  waiting: "border-zinc-300 bg-white text-zinc-500",
  running: "border-[#226f54] bg-[#e8f5ef] text-[#174a39]",
  done: "border-[#226f54] bg-[#f5fbf8] text-[#174a39]",
  cancelled: "border-[#d84c3f] bg-[#fff0ee] text-[#8f2118]",
  failed: "border-[#a05c00] bg-[#fff7e6] text-[#6b3a00]",
};

const statusIcons: Record<NodeStatus, typeof CircleDashed> = {
  waiting: CircleDashed,
  running: PlayCircle,
  done: CheckCircle2,
  cancelled: XCircle,
  failed: OctagonX,
};

export interface RuntimeTreeProps {
  phase: RunPhase;
  runStep?: number;
  nodes: RuntimeNode[];
}

/** Render an owned task tree with phase-specific node states. */
export function RuntimeTree({ phase, runStep = 0, nodes }: RuntimeTreeProps) {
  return (
    <div className="space-y-3">
      {nodes.map((node) => (
        <RuntimeTreeNode key={node.id} node={node} phase={phase} runStep={runStep} depth={0} siblingIndex={0} />
      ))}
    </div>
  );
}

interface RuntimeTreeNodeProps {
  node: RuntimeNode;
  phase: RunPhase;
  runStep: number;
  depth: number;
  siblingIndex: number;
}

function RuntimeTreeNode({ node, phase, runStep, depth, siblingIndex }: RuntimeTreeNodeProps) {
  const status = resolveNodeStatus(node, phase, runStep, depth, siblingIndex);
  const Icon = statusIcons[status];

  return (
    <div>
      <div
        className={`grid grid-cols-[auto_1fr_auto] items-center gap-3 border p-3 text-sm shadow-[0_1px_0_rgba(18,22,25,0.04)] transition-colors duration-150 ${status === "running" ? "ring-2 ring-[#edcf89]/70" : ""} ${statusClasses[status]}`}
        style={{ marginLeft: depth * 18, borderRadius: 8 }}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <div className="truncate font-semibold text-zinc-950">{node.label}</div>
          <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">{node.kind}</div>
        </div>
        <span className="justify-self-end text-xs font-semibold uppercase tracking-[0.08em]">{status}</span>
      </div>
      {node.children ? (
        <div className="mt-3 space-y-3 border-l border-zinc-200 pl-3">
          {node.children.map((child, index) => (
            <RuntimeTreeNode key={child.id} node={child} phase={phase} runStep={runStep} depth={depth + 1} siblingIndex={index} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function resolveNodeStatus(
  node: RuntimeNode,
  phase: RunPhase,
  runStep: number,
  depth: number,
  siblingIndex: number,
): NodeStatus {
  if (phase !== "running" || depth === 0) {
    return node.statusByPhase[phase];
  }

  const activeIndex = runStep - 1;

  if (siblingIndex < activeIndex) {
    return "done";
  }

  if (siblingIndex === activeIndex) {
    return "running";
  }

  return "waiting";
}
