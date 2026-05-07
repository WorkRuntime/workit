/**
 * Validates the generated release SBOM.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This gate keeps the SBOM aligned with the published package contract. It is
 * intentionally strict because runtime dependency drift must be visible before
 * publication.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const sbom = JSON.parse(await readFile("dist/workit-core.sbom.cdx.json", "utf8"));
const rootRef = packagePurl(packageJson.name, packageJson.version);

assert.equal(sbom.bomFormat, "CycloneDX", "SBOM must use CycloneDX");
assert.equal(sbom.specVersion, "1.6", "SBOM spec version changed");
assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/u, "SBOM serial number must be a UUID URN");
assert.equal(sbom.metadata?.component?.name, packageJson.name, "SBOM root component name changed");
assert.equal(sbom.metadata?.component?.version, packageJson.version, "SBOM root component version changed");
assert.equal(sbom.metadata?.component?.["bom-ref"], rootRef, "SBOM root bom-ref changed");
assert.equal(sbom.metadata?.component?.licenses?.[0]?.license?.id, "Apache-2.0", "SBOM license must be Apache-2.0");
assert.deepEqual(sbom.components, [], "Published WorkIt runtime SBOM must not list runtime dependencies");
assert.deepEqual(sbom.dependencies, [{ ref: rootRef, dependsOn: [] }], "Published WorkIt runtime dependency graph must be empty");

const runtimeDependencyCount = sbom.metadata.component.properties
  .find((property) => property.name === "workit.runtimeDependencies")?.value;
assert.equal(runtimeDependencyCount, "0", "SBOM runtime dependency property must be zero");

console.log("sbom-gate: CycloneDX release SBOM validated");

function packagePurl(name, version) {
  if (!name.startsWith("@")) return `pkg:npm/${name}@${version}`;
  const [scope, packageName] = name.split("/");
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`;
}
