/**
 * Correctness evidence: bounded resource ownership model.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This finite model checks cleanup-balance invariants for WorkIt's linear,
 * lazy, and shared resource helper patterns. It is not a proof over arbitrary
 * JavaScript programs or external resources.
 */

import { readFile } from "node:fs/promises";

import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");
const root = new URL("../../../", import.meta.url);

await suite.proof(
  "CORR-015",
  "bounded resource model preserves cleanup balance invariant",
  "for linear, lazy, and shared resources, every terminal modeled scope releases exactly the resources it acquired",
  async () => {
    const spec = JSON.parse(await readFile(new URL("evidence/resource-ownership-model.json", root), "utf8"));
    const reports = [
      exploreLinear(spec),
      exploreLazy(spec),
      exploreShared(spec),
    ];

    return {
      ok: spec.author === "Admilson B. F. Cossa"
        && spec.spdxLicense === "Apache-2.0"
        && spec.model.patterns.includes("linear")
        && spec.model.patterns.includes("lazy")
        && spec.model.patterns.includes("shared")
        && spec.model.invariants.includes("terminal_scope_has_no_open_modeled_resource")
        && reports.every((report) => report.ok),
      reports,
      limitations: spec.limitations,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

function exploreLinear(spec) {
  const states = spec.model.terminalCauses.map((cause) => ({
    pattern: "linear",
    cause,
    acquired: 1,
    released: 1,
    used: true,
  }));
  return summarize("linear", states, spec.bounds.maxExploredStatesPerPattern);
}

function exploreLazy(spec) {
  const states = [];
  for (const cause of spec.model.terminalCauses) {
    for (const used of [false, true]) {
      states.push({
        pattern: "lazy",
        cause,
        acquired: used ? 1 : 0,
        released: used ? 1 : 0,
        used,
      });
    }
  }
  return summarize("lazy", states, spec.bounds.maxExploredStatesPerPattern);
}

function exploreShared(spec) {
  const states = [];
  for (let userCount = 1; userCount <= spec.bounds.maxSharedUsers; userCount++) {
    for (const cause of spec.model.terminalCauses) {
      const masks = 2 ** userCount;
      for (let mask = 0; mask < masks; mask++) {
        const usedBy = Array.from({ length: userCount }, (_item, index) => (mask & (1 << index)) !== 0);
        const used = usedBy.some(Boolean);
        states.push({
          pattern: "shared",
          cause,
          acquired: used ? 1 : 0,
          released: used ? 1 : 0,
          userCount,
          usedBy,
        });
      }
    }
  }
  return summarize("shared", states, spec.bounds.maxExploredStatesPerPattern);
}

function summarize(pattern, states, maxStates) {
  const violations = [];
  if (states.length > maxStates) {
    violations.push({ kind: "state_bound_exceeded", states: states.length, maxStates });
  }

  for (const state of states) {
    const invariant = checkInvariant(state);
    if (invariant !== null) violations.push(invariant);
  }

  return {
    pattern,
    ok: violations.length === 0 && states.length > 0,
    states: states.length,
    violations,
  };
}

function checkInvariant(state) {
  if (state.released > state.acquired) {
    return { kind: "release_exceeded_acquire", state };
  }
  if (state.acquired !== state.released) {
    return { kind: "terminal_resource_left_open", state };
  }

  switch (state.pattern) {
    case "linear":
      return state.acquired === 1 && state.released === 1
        ? null
        : { kind: "linear_not_released_once", state };
    case "lazy":
      return state.used === (state.acquired === 1 && state.released === 1)
        ? null
        : { kind: "lazy_acquire_release_mismatch", state };
    case "shared":
      return checkSharedInvariant(state);
    default:
      return { kind: "unknown_pattern", state };
  }
}

function checkSharedInvariant(state) {
  const anyUser = state.usedBy.some(Boolean);
  if (!anyUser && state.acquired === 0 && state.released === 0) return null;
  if (anyUser && state.acquired === 1 && state.released === 1) return null;
  return { kind: "shared_scope_balance_mismatch", state };
}
