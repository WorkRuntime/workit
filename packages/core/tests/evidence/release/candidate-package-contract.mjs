/**
 * Release evidence for the built candidates subpath contract.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createSuite } from "../harness.mjs";

const require = createRequire(import.meta.url);
const suite = createSuite("release");

await suite.proof(
  "REL-008",
  "candidates subpath has locked ESM CommonJS and type artifacts",
  "the package export resolves dedicated ESM, CommonJS, and declaration artifacts without adding firstAcceptable to the root API",
  async () => {
    const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
    const esm = await import("../../../dist/candidates/index.js");
    const cjs = require("../../../dist-cjs/candidates/index.cjs");
    const root = await import("../../../dist/index.js");
    const declaration = await readFile(new URL("../../../dist/candidates/index.d.ts", import.meta.url), "utf8");
    const candidateExport = packageJson.exports?.["./candidates"];
    return {
      ok: candidateExport?.types === "./dist/candidates/index.d.ts"
        && candidateExport?.node?.import === "./dist/candidates/index.js"
        && candidateExport?.node?.require === "./dist-cjs/candidates/index.cjs"
        && candidateExport?.default === "./dist/runtime/unsupported.js"
        && typeof esm.firstAcceptable === "function"
        && typeof cjs.firstAcceptable === "function"
        && !("firstAcceptable" in root)
        && declaration.includes("firstAcceptable"),
      export: candidateExport,
      esm: typeof esm.firstAcceptable,
      commonjs: typeof cjs.firstAcceptable,
      rootHasFirstAcceptable: "firstAcceptable" in root,
      declarationsContainFirstAcceptable: declaration.includes("firstAcceptable"),
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
