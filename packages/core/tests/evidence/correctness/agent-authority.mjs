/**
 * Correctness evidence: declared agent tool authority.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentCapabilityError, runAgent } from "../../../dist/ai/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-006",
  "agent authority denies undeclared capability before tool execution",
  "denied declared tool capability emits agent:tool_denied and the tool body is never called",
  async () => {
    let called = false;
    const result = await runAgent(async (agent) => {
      try {
        await agent.tool("write", undefined, async () => {
          called = true;
          return "unexpected";
        }, { capability: "repo:write" });
      } catch (error) {
        if (!(error instanceof AgentCapabilityError)) throw error;
      }
      return "handled";
    }, {
      authority: { allowedCapabilities: ["repo:read"] },
    });
    const denied = result.events.find((event) => event.type === "agent:tool_denied");

    return {
      ok: result.result === "handled"
        && !called
        && denied?.capability === "repo:write"
        && denied.reason === "capability_not_allowed",
      called,
      events: result.events.map((event) => event.type),
      denied,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
