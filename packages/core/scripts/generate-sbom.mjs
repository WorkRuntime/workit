/**
 * Generates a release SBOM for the published WorkIt artifact.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The runtime package intentionally has no runtime dependencies. The SBOM is
 * generated from package metadata during build so the packed artifact contains
 * a machine-readable provenance companion without committing generated output.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("../../package-lock.json", "utf8"));
const packageLockEntry = packageLock.packages?.["packages/core"] ?? {};
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});

if (runtimeDependencies.length > 0) {
  throw new Error(`SBOM generation requires zero runtime dependencies; found ${runtimeDependencies.join(", ")}`);
}

const bomRef = packagePurl(packageJson.name, packageJson.version);
const lockDigest = createHash("sha256")
  .update(JSON.stringify({
    name: packageLockEntry.name,
    version: packageLockEntry.version,
    license: packageLockEntry.license,
    peerDependencies: packageLockEntry.peerDependencies ?? {},
  }))
  .digest("hex");
const serialNumber = deterministicUuid(`${bomRef}:${lockDigest}`);

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${serialNumber}`,
  version: 1,
  metadata: {
    tools: {
      components: [{
        type: "application",
        name: "workit-sbom-generator",
        version: packageJson.version,
      }],
    },
    component: {
      type: "library",
      "bom-ref": bomRef,
      name: packageJson.name,
      version: packageJson.version,
      author: packageJson.author,
      licenses: [{ license: { id: packageJson.license } }],
      purl: bomRef,
      properties: [
        { name: "workit.runtimeDependencies", value: "0" },
        { name: "workit.packageLockRootDigest", value: lockDigest },
      ],
    },
  },
  components: [],
  dependencies: [{
    ref: bomRef,
    dependsOn: [],
  }],
};

await mkdir("dist", { recursive: true });
await writeFile(join("dist", "workit-core.sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

function packagePurl(name, version) {
  if (!name.startsWith("@")) return `pkg:npm/${name}@${version}`;
  const [scope, packageName] = name.split("/");
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`;
}

function deterministicUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
