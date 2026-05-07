/**
 * Worker offload contract documentation gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Worker offload is an execution and structured-clone boundary. This gate keeps
 * the public README and SECURITY guidance aligned with the runtime policy.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readme = await readFile("README.md", "utf8");
const security = await readFile("SECURITY.md", "utf8");

const REQUIRED_README_MARKERS = [
  "## Worker Offload Boundary",
  "Accepted worker inputs",
  "Rejected worker inputs",
  "plain objects",
  "class instances",
  "functions",
  "symbols",
  "parent directory segments",
  "timeout",
];

const REQUIRED_SECURITY_MARKERS = [
  "plain structured-clone data",
  "class instances",
  "inline and remote module URLs",
  "parent directory traversal",
  "terminates the worker thread",
];

for (const marker of REQUIRED_README_MARKERS) {
  assert.ok(readme.includes(marker), `README missing worker contract marker: ${marker}`);
}
for (const marker of REQUIRED_SECURITY_MARKERS) {
  assert.ok(security.includes(marker), `SECURITY missing worker contract marker: ${marker}`);
}

console.log(JSON.stringify({
  workerContractDocs: "ok",
  readmeMarkers: REQUIRED_README_MARKERS.length,
  securityMarkers: REQUIRED_SECURITY_MARKERS.length,
}));
