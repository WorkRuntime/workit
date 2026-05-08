/**
 * Publication evidence harness for WorkIt claim proofs.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from "node:perf_hooks";

export function createSuite(area) {
  const results = [];

  return {
    async proof(id, title, expectedInvariant, fn) {
      const started = performance.now();
      try {
        const evidence = await fn();
        const ok = evidence?.ok === true;
        const elapsedMs = Math.round(performance.now() - started);
        results.push({
          id,
          area,
          title,
          expectedInvariant,
          status: ok ? "pass" : "fail",
          elapsedMs,
          evidence,
        });
        printResult(ok, id, title, elapsedMs, evidence);
      } catch (error) {
        const elapsedMs = Math.round(performance.now() - started);
        const evidence = { error: error?.message ?? String(error) };
        results.push({
          id,
          area,
          title,
          expectedInvariant,
          status: "fail",
          elapsedMs,
          evidence,
        });
        printResult(false, id, title, elapsedMs, evidence);
      }
    },
    summary() {
      const failed = results.filter((result) => result.status !== "pass");
      return {
        area,
        passed: results.length - failed.length,
        failed: failed.length,
        results,
      };
    },
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function printResult(ok, id, title, elapsedMs, evidence) {
  const status = ok ? "PASS" : "FAIL";
  process.stdout.write(`${status} ${id} ${title} (${elapsedMs}ms)\n`);
  process.stdout.write(`  evidence: ${JSON.stringify(evidence)}\n`);
}
