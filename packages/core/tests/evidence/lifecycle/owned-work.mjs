/**
 * Lifecycle evidence: owned cancellation, retry, and cleanup behavior.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { CancellationError, run } from "../../../dist/index.js";
import { createSuite, sleep } from "../harness.mjs";

const suite = createSuite("lifecycle");

await suite.proof(
  "LIFE-001",
  "run.race cancels losing branches",
  "losing branches receive race_lost cancellation",
  async () => {
    const losers = [];
    const make = (name, ms) => async (ctx) => {
      try {
        await sleep(ms, ctx.signal);
        return name;
      } catch (error) {
        losers.push({
          name,
          className: error?.constructor?.name,
          reasonKind: error instanceof CancellationError ? error.reason.kind : null,
        });
        throw error;
      }
    };

    const winner = await run.race([
      make("slow-a", 80),
      make("fast", 5),
      make("slow-b", 90),
    ]);

    return {
      ok: winner === "fast"
        && losers.length === 2
        && losers.every((loser) => loser.reasonKind === "race_lost"),
      winner,
      losers,
    };
  },
);

await suite.proof(
  "LIFE-002",
  "run.retry stops on parent cancellation",
  "no extra retry attempt runs after cancellation is observed",
  async () => {
    let scopeRef;
    let attemptsAfterCancel = 0;
    let cancelRequested = false;

    const retried = run.retry(async (ctx) => {
      if (cancelRequested && ctx.attempt > 1) attemptsAfterCancel++;
      await sleep(20, ctx.signal);
      throw new Error(`attempt ${ctx.attempt}`);
    }, { times: 8, initialDelay: "50ms", jitter: false, backoff: "fixed" });

    const promise = run.scope(async (scope) => {
      scopeRef = scope;
      await scope.spawn(retried, { name: "retry-proof" });
    });

    setTimeout(() => {
      cancelRequested = true;
      scopeRef.cancel({ kind: "manual", tag: "evidence" });
    }, 45);

    let error;
    try {
      await promise;
    } catch (caught) {
      error = caught;
    }

    return {
      ok: error instanceof CancellationError
        && error.reason.kind === "manual"
        && attemptsAfterCancel === 0,
      errorClass: error?.constructor?.name,
      reasonKind: error?.reason?.kind,
      attemptsAfterCancel,
    };
  },
);

await suite.proof(
  "LIFE-003",
  "run.bracket cleanup timeout is bounded and observable",
  "a hanging cleanup emits task:cleanup_timeout and the owner settles",
  async () => {
    const events = [];
    const startedAt = Date.now();
    await run.scope(async (scope) => {
      scope.onEvent((event) => events.push(event));
      await scope.spawn(run.bracket(
        async () => "resource",
        async () => "used",
        async () => new Promise(() => {}),
        { timeout: 10 },
      ));
    });
    const elapsedMs = Date.now() - startedAt;
    const cleanupTimeout = events.find((event) => event.type === "task:cleanup_timeout");

    return {
      ok: Boolean(cleanupTimeout) && elapsedMs < 500,
      elapsedMs,
      cleanupTimeout: cleanupTimeout
        ? { type: cleanupTimeout.type, timeoutMs: cleanupTimeout.timeoutMs }
        : null,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
