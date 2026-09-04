/**
 * Stable launch targets for real WorkIt execution environments.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

export const LAB_DEVCONTAINER_PATH = "examples/ai-failure-lab/.devcontainer/devcontainer.json";
export const WORKIT_RUNTIME_VERSION = "0.6.1";

const codespacesUrl = new URL("https://codespaces.new/WorkRuntime/workit");
codespacesUrl.searchParams.set("devcontainer_path", LAB_DEVCONTAINER_PATH);
codespacesUrl.searchParams.set("quickstart", "1");

export const REAL_WORKIT_LAUNCH_URL = codespacesUrl.href;
