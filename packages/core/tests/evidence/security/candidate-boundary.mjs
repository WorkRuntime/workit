/**
 * Security evidence for candidate metadata normalization.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { firstAcceptable } from "../../../dist/candidates/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("security");

await suite.proof(
  "SEC-003",
  "candidate evidence keeps prototype-shaped metadata inert and redacted",
  "metadata normalization preserves an own __proto__ field without changing Object.prototype and redacts secret fields",
  async () => {
    const metadata = JSON.parse('{"__proto__":{"polluted":true},"token":"secret","provider":"primary"}');
    const result = await firstAcceptable(["candidate"], {
      execute: async (candidate) => candidate,
      accept: async () => ({ accepted: true }),
      classifyFailure: async () => ({ disposition: "terminal", reasonCode: "unexpected_failure" }),
      candidateMetadata: () => metadata,
      evidence: { maxAttempts: 1, maxMetadataBytes: 256 },
    });
    const captured = result.evidence[0]?.metadata;
    return {
      ok: result.status === "accepted"
        && Object.hasOwn(captured ?? {}, "__proto__")
        && captured?.__proto__?.polluted === true
        && captured?.token === "[redacted]"
        && Object.prototype.polluted === undefined
        && ({}).polluted === undefined,
      status: result.status,
      hasOwnProto: Object.hasOwn(captured ?? {}, "__proto__"),
      token: captured?.token,
      objectPrototypePolluted: Object.prototype.polluted ?? null,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
