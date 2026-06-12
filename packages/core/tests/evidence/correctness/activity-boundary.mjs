/**
 * Correctness evidence: explicit activity boundaries preserve terminal records.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { group } from "../../../dist/index.js";
import {
  ActivityConflictError,
  createMemoryActivityStore,
  runActivity,
} from "../../../dist/activity/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("correctness");

await suite.proof(
  "CORR-012",
  "explicit activity boundary preserves terminal evidence",
  "completed activity returns the stored result on repeat and changed input conflicts before rerun",
  async () => {
    const store = createMemoryActivityStore();
    const spec = { activityId: "activity-boundary-proof", input: { requestId: "r1" } };
    let runs = 0;
    let conflict = false;
    let conflictBodyRuns = 0;

    const first = await group(async (task) => task(runActivity(store, spec, async () => {
      runs++;
      return "stored-result";
    })));
    const second = await group(async (task) => task(runActivity(store, spec, async () => {
      runs++;
      return "unexpected";
    })));

    try {
      await group(async (task) => task(runActivity(
        store,
        { activityId: spec.activityId, input: { requestId: "r2" } },
        async () => {
          conflictBodyRuns++;
          return "unexpected";
        },
      )));
    } catch (error) {
      conflict = error instanceof ActivityConflictError;
    }

    const record = await store.get(spec.activityId);

    return {
      ok: first === "stored-result"
        && second === "stored-result"
        && runs === 1
        && conflict
        && conflictBodyRuns === 0
        && record?.status === "completed"
        && record.result === "stored-result",
      first,
      second,
      runs,
      conflict,
      conflictBodyRuns,
      recordStatus: record?.status,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
