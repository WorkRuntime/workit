/**
 * Lifecycle evidence: explicit activity boundaries survive process-shaped restarts.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { group } from "../../../dist/index.js";
import { createFileActivityStore, runActivity } from "../../../dist/activity/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("lifecycle");

await suite.proof(
  "LIFE-008",
  "file activity store replays completed activity after restart",
  "a fresh file activity store returns the persisted terminal result without rerunning the activity body",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "workit-activity-evidence-"));

    try {
      const spec = { activityId: "activity-restart-proof", input: { requestId: "r1", page: 1 } };
      let bodyRuns = 0;

      const first = await group(async (task) => task(runActivity(
        createFileActivityStore({ dir }),
        spec,
        async () => {
          bodyRuns++;
          return { uploaded: 4, skipped: 0 };
        },
        { clock: () => 10 },
      )));

      const second = await group(async (task) => task(runActivity(
        createFileActivityStore({ dir }),
        spec,
        async () => {
          bodyRuns++;
          return { uploaded: 0, skipped: 4 };
        },
        { clock: () => 20 },
      )));

      const record = await createFileActivityStore({ dir }).get(spec.activityId);

      return {
        ok: first.uploaded === 4
          && second.uploaded === 4
          && bodyRuns === 1
          && record?.status === "completed"
          && record.result.uploaded === 4,
        first,
        second,
        bodyRuns,
        recordStatus: record?.status,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
