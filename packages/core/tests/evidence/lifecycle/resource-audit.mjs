/**
 * Lifecycle evidence: resource cleanup audit visibility.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { run } from "../../../dist/index.js";
import { bracketLazy, scopeAcquire } from "../../../dist/resources/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("lifecycle");

await suite.proof(
  "LIFE-011",
  "resource ownership can be audited across success, failure, and timeout cleanup paths",
  "resource audit instrumentation records acquired/released/pending resources while WorkIt emits cleanup timeout and failure events",
  async () => {
    const audit = createResourceAudit();
    const events = [];
    const task = bracketLazy(
      async () => audit.acquire("task:lazy"),
      async (resource) => {
        await resource.get();
        return "used";
      },
      async (resource) => {
        audit.releaseStarted(resource.id);
        audit.releaseCompleted(resource.id);
      },
    );

    const value = await run.scope(async (scope) => {
      scope.onEvent((event) => events.push(event));
      const scopeResource = audit.acquire("scope:success");
      scopeAcquire(scope, scopeResource, async (resource) => {
        audit.releaseStarted(resource.id);
        audit.releaseCompleted(resource.id);
      });

      const failingResource = audit.acquire("scope:failure");
      scopeAcquire(scope, failingResource, async (resource) => {
        audit.releaseStarted(resource.id);
        throw new Error("release failed");
      });

      const hangingResource = audit.acquire("scope:timeout");
      scopeAcquire(scope, hangingResource, async (resource) => {
        audit.releaseStarted(resource.id);
        await new Promise(() => undefined);
      }, { timeout: 5 });

      return await scope.spawn(task, { name: "resource.audit" });
    });

    return {
      ok: value === "used"
        && audit.acquired.length === 4
        && audit.released.includes("task:lazy")
        && audit.released.includes("scope:success")
        && audit.pending.includes("scope:failure")
        && audit.pending.includes("scope:timeout")
        && events.some((event) => event.type === "scope:cleanup_failed")
        && events.some((event) => event.type === "scope:cleanup_timeout" && event.timeoutMs === 5),
      acquired: audit.acquired,
      released: audit.released,
      pending: audit.pending,
      cleanupEvents: events.filter((event) => event.type.includes("cleanup")).map((event) => event.type),
      claimBoundary: "successful resource audit entries are explicit instrumentation; cleanup failure and timeout visibility comes from WorkIt scope events",
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);

function createResourceAudit() {
  const acquired = [];
  const released = [];
  const pending = new Set();

  return {
    get acquired() {
      return [...acquired];
    },
    get released() {
      return [...released];
    },
    get pending() {
      return [...pending];
    },
    acquire(id) {
      acquired.push(id);
      return { id };
    },
    releaseStarted(id) {
      pending.add(id);
    },
    releaseCompleted(id) {
      pending.delete(id);
      released.push(id);
    },
  };
}
