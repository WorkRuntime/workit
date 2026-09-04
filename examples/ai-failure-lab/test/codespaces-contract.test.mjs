/**
 * Contract tests for the real-Node one-click execution target.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LAB_DEVCONTAINER_PATH,
  REAL_WORKIT_LAUNCH_URL,
} from "../launch-targets.mjs";

const EXPECTED_WORKSPACE = "/workspaces/${localWorkspaceFolderBasename}/examples/ai-failure-lab";

test("real WorkIt launch target uses the bounded Codespaces dev container", async () => {
  const launchUrl = new URL(REAL_WORKIT_LAUNCH_URL);
  const devcontainer = JSON.parse(await readFile(
    fileURLToPath(new URL("../.devcontainer/devcontainer.json", import.meta.url)),
    "utf8",
  ));

  assert.equal(launchUrl.origin, "https://codespaces.new");
  assert.equal(launchUrl.pathname, "/WorkRuntime/workit");
  assert.equal(launchUrl.searchParams.get("devcontainer_path"), LAB_DEVCONTAINER_PATH);
  assert.equal(launchUrl.searchParams.get("quickstart"), "1");
  assert.equal(REAL_WORKIT_LAUNCH_URL.includes("stackblitz"), false);

  assert.equal(devcontainer.workspaceFolder, EXPECTED_WORKSPACE);
  assert.equal(devcontainer.postCreateCommand, "npm ci --no-audit --no-fund && npm test");
  assert.equal(devcontainer.postAttachCommand, "npm start");
  assert.equal(devcontainer.waitFor, "postCreateCommand");
  assert.match(devcontainer.image, /javascript-node:1-22-bookworm$/);
});
