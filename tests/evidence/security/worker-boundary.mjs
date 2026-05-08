/**
 * Security evidence: worker URL guard and hard timeout boundary.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TimeoutError, run } from "../../../dist/index.js";
import { offload } from "../../../dist/worker/index.js";
import { createSuite } from "../harness.mjs";

const suite = createSuite("security");
const spinnerURL = new URL("./cpu-spinner.mjs", import.meta.url);

await suite.proof(
  "SEC-001",
  "worker offload rejects remote and executable URL schemes",
  "data, http, https, and javascript worker inputs are rejected before import",
  async () => {
    const rejected = [];
    for (const candidate of [
      "data:text/javascript,export const x = 1",
      "http://example.test/worker.js",
      "https://example.test/worker.js",
      "javascript:globalThis.x=1",
    ]) {
      try {
        offload(candidate, "x", undefined);
      } catch {
        rejected.push(candidate.split(":")[0]);
      }
    }

    return {
      ok: rejected.length === 4,
      rejected,
    };
  },
);

await suite.proof(
  "SEC-002",
  "worker timeout terminates non-cooperative CPU work",
  "late marker is not written after offload timeout",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "workit-evidence-worker-"));
    const markerPath = join(dir, "late-marker.txt");
    let error;
    try {
      await run.scope(async (scope) => {
        await scope.spawn(offload(
          spinnerURL,
          "spinForever",
          { durationMs: 5_000, markerPath },
          { timeout: "200ms" },
        ));
      });
    } catch (caught) {
      error = caught;
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
    const markerExists = existsSync(markerPath);
    rmSync(dir, { recursive: true, force: true });

    return {
      ok: error instanceof TimeoutError && markerExists === false,
      errorClass: error?.constructor?.name,
      markerExists,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
