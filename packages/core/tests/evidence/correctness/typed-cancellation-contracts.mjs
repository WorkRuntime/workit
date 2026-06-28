/**
 * Evidence proof for typed cancellation contract boundaries.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSuite } from "../harness.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const suite = createSuite("correctness");
const root = new URL("../../../", import.meta.url);
const tscCli = require.resolve("typescript/bin/tsc");

await suite.proof(
  "CORR-023",
  "typed cancellation contracts reject undeclared task composition",
  "tsc accepts declared cancellable/shielded composition and rejects plain or misrouted tasks",
  async () => {
    const result = await execFileAsync(
      process.execPath,
      [
        tscCli,
        "--noEmit",
        "--ignoreConfig",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--noUncheckedIndexedAccess",
        "--skipLibCheck",
        join("tests", "types", "contracts.ts"),
      ],
      { cwd: fileURLToPath(root), timeout: 120_000 },
    );

    return {
      ok: result.stdout.trim().length === 0 && result.stderr.trim().length === 0,
      fixture: "tests/types/contracts.ts",
      compiler: "tsc --noEmit",
      claimBoundary: "compile-time intent contract, not body-level cancellation proof",
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
