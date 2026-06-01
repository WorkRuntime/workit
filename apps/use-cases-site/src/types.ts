/**
 * Public content contracts for WorkIt use case pages.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export type RunPhase = "idle" | "running" | "completed" | "aborted";

export type NodeStatus = "waiting" | "running" | "done" | "cancelled" | "failed";

export type FeatureTone = "coral" | "emerald" | "amber" | "cobalt" | "ink";

export interface WorkItFeature {
  label: string;
  reason: string;
  tone: FeatureTone;
}

export interface UserFlowStep {
  userAction: string;
  runtimeOwner: string;
  feature: string;
}

export interface RuntimeNode {
  id: string;
  label: string;
  kind: string;
  statusByPhase: Record<RunPhase, NodeStatus>;
  children?: RuntimeNode[];
}

export interface EvidenceItem {
  claim: string;
  path: string;
  invariant: string;
  status: "tracked" | "planned";
}

export interface UseCase {
  id: string;
  title: string;
  audience: string;
  summary: string;
  pain: string;
  answer: string;
  primarySample: string;
  features: WorkItFeature[];
  flow: UserFlowStep[];
  runtimeTree: RuntimeNode[];
  events: Record<RunPhase, string[]>;
  receipt: Record<RunPhase, string[]>;
  evidence: EvidenceItem[];
  code: string;
}

export type ExampleRunSource = "live-node" | "captured-build";

export interface ExampleRunResult {
  source: ExampleRunSource;
  sample: string;
  events: string[];
  receipt: string[];
  code?: string;
}
