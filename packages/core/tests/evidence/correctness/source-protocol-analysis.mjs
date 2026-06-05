/**
 * Correctness evidence: bounded source protocol analysis.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This proof checks caller-provided source protocol specifications. It does
 * not parse arbitrary JavaScript or claim whole-program static analysis.
 */

import { verifySourceProtocol } from "../../../dist/analysis/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-017",
  "source protocol analysis detects missing ownership edges",
  "bounded source protocol specs pass when WorkIt ownership edges are present and fail with stable findings when resource, side-effect, parallelism, time-policy, or authority edges are missing",
  async () => {
    const owned = verifySourceProtocol({
      version: "workit.source-protocol.v1",
      modules: [
        {
          moduleId: "owned.pipeline",
          functions: [
            {
              functionId: "uploadBatch",
              kind: "handler",
              uses: [
                { operation: "resource.acquire", target: "temp-dir" },
                { operation: "ctx.defer", target: "temp-dir" },
                { operation: "durable.side_effect", target: "object-store" },
                { operation: "activity.run", target: "object-store" },
                { operation: "promise.all", target: "files" },
                { operation: "run.pool", target: "files" },
                { operation: "run.retry", target: "object-store" },
                { operation: "time_policy.plan", target: "object-store" },
              ],
            },
            {
              functionId: "writeTool",
              kind: "agent_tool",
              uses: [
                { operation: "authority.check", capability: "repo:write" },
                { operation: "durable.side_effect", target: "repo" },
                { operation: "receipt.append", target: "repo-write" },
              ],
            },
          ],
        },
      ],
    });

    const unsafe = verifySourceProtocol({
      modules: [
        {
          moduleId: "unsafe.pipeline",
          functions: [
            {
              functionId: "uploadBatch",
              kind: "handler",
              uses: [
                { operation: "resource.acquire", target: "temp-dir" },
                { operation: "durable.side_effect", target: "object-store" },
                { operation: "promise.all", target: "files" },
                { operation: "run.retry", target: "object-store" },
              ],
            },
            {
              functionId: "writeTool",
              kind: "agent_tool",
              uses: [
                { operation: "agent.tool" },
                { operation: "durable.side_effect", target: "repo" },
                { operation: "activity.run", target: "repo" },
              ],
            },
          ],
        },
      ],
    });
    const unsafeCodes = unsafe.findings.map((finding) => finding.code).sort();
    const expectedCodes = [
      "source_agent_tool_without_authority",
      "source_durable_side_effect_without_evidence",
      "source_parallel_without_bound",
      "source_resource_without_cleanup",
      "source_time_policy_unplanned",
    ];

    return {
      ok: owned.status === "pass"
        && owned.checkedFunctions === 2
        && unsafe.status === "fail"
        && expectedCodes.every((code) => unsafeCodes.includes(code)),
      owned: {
        status: owned.status,
        checkedModules: owned.checkedModules,
        checkedFunctions: owned.checkedFunctions,
        checkedUses: owned.checkedUses,
      },
      unsafe: {
        status: unsafe.status,
        findings: unsafeCodes,
      },
      limitations: [
        "This verifies caller-provided source protocol specifications, not arbitrary JavaScript source.",
        "It checks bounded ownership edges and does not prove whole-program correctness.",
      ],
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
