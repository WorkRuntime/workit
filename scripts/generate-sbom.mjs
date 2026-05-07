/**
 * Generates a release SBOM for the published WorkJS artifact.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The runtime package intentionally has no runtime dependencies. The SBOM is
 * generated from package metadata during build so the packed artifact contains
 * a machine-readable provenance companion without committing generated output.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const rootLock = packageLock.packages?.[""] ?? {};
const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});

if (runtimeDependencies.length > 0) {
  throw new Error(`SBOM generation requires zero runtime dependencies; found ${runtimeDependencies.join(", ")}`);
}

const bomRef = `pkg:npm/${packageJson.name}@${packageJson.version}`;
const lockDigest = createHash("sha256")
  .update(JSON.stringify({
    name: rootLock.name,
    version: rootLock.version,
    license: rootLock.license,
    peerDependencies: rootLock.peerDependencies ?? {},
  }))
  .digest("hex");

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: {
      components: [{
        type: "application",
        name: "workjs-sbom-generator",
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
        { name: "workjs.runtimeDependencies", value: "0" },
        { name: "workjs.packageLockRootDigest", value: lockDigest },
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
await writeFile(join("dist", "workjs.sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
