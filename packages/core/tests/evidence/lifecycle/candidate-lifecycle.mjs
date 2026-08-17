/**
 * Lifecycle evidence for candidate deadline and callback cancellation authority.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { CancellationError } from "../../../dist/index.js";
import { firstAcceptable } from "../../../dist/candidates/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("lifecycle");

await suite.proof(
  "LIFE-013",
  "candidate deadline is aggregate and terminal across the chain",
  "one absolute deadline reaches the admitted candidate context and timeout admits no fallback candidate",
  async () => {
    const deadlineAt = Date.now() + 15;
    const admitted = [];
    const observedDeadlines = [];
    const result = await firstAcceptable(["slow", "fallback"], {
      execute: async (candidate, ctx) => {
        admitted.push(candidate);
        observedDeadlines.push(ctx.deadlineAt);
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      },
      accept: async () => ({ accepted: true }),
      classifyFailure: async () => ({ disposition: "try_next_candidate", reasonCode: "provider_failure" }),
      deadlineAt,
    });

    return {
      ok: result.status === "terminal"
        && result.reasonCode === "workit_timeout"
        && JSON.stringify(admitted) === JSON.stringify(["slow"])
        && JSON.stringify(observedDeadlines) === JSON.stringify([deadlineAt]),
      status: result.status,
      reasonCode: result.status === "terminal" ? result.reasonCode : null,
      admitted,
      observedDeadlines,
      deadlineAt,
    };
  },
);

await suite.proof(
  "LIFE-014",
  "candidate callback cancellation remains authoritative",
  "cancellation thrown by quality or classification callbacks propagates unchanged and admits no fallback",
  async () => {
    const qualityCancellation = new CancellationError({ kind: "manual", tag: "quality-stop" });
    const classifierCancellation = new CancellationError({ kind: "manual", tag: "classifier-stop" });
    const admitted = [];
    const observed = [];

    for (const scenario of ["quality", "classifier"]) {
      try {
        await firstAcceptable(["primary", "fallback"], {
          execute: async (candidate) => {
            admitted.push(`${scenario}:${candidate}`);
            if (scenario === "classifier") throw new Error("provider failure");
            return candidate;
          },
          accept: async () => {
            if (scenario === "quality") throw qualityCancellation;
            return { accepted: true };
          },
          classifyFailure: async () => { throw classifierCancellation; },
        });
      } catch (error) {
        observed.push(error);
      }
    }

    return {
      ok: observed[0] === qualityCancellation
        && observed[1] === classifierCancellation
        && JSON.stringify(admitted) === JSON.stringify(["quality:primary", "classifier:primary"]),
      admitted,
      cancellationTags: observed.map((error) => error?.reason?.tag),
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
