/**
 * Worker module URL boundary validation.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Worker offload executes a caller-selected module export. The runtime accepts
 * local file modules only; remote and inline URL schemes are rejected before the
 * worker imports anything.
 */

const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/u;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/u;

/** Normalizes a caller-provided worker module reference and rejects executable URL schemes. */
export function normalizeWorkerModuleURL(moduleURL: string | URL): string {
  const href = moduleURL instanceof URL ? moduleURL.href : moduleURL;
  if (href.trim().length === 0) throw new TypeError("Worker moduleURL must not be empty");
  assertNoParentTraversal(href);

  if (moduleURL instanceof URL) {
    assertAllowedProtocol(moduleURL.protocol);
    return href;
  }

  if (URL_SCHEME.test(href) && !WINDOWS_DRIVE_PATH.test(href)) {
    assertAllowedProtocol(new URL(href).protocol);
  }

  return href;
}

function assertAllowedProtocol(protocol: string): void {
  if (protocol !== "file:") {
    throw new TypeError("Worker moduleURL must be a local file URL or path");
  }
}

function assertNoParentTraversal(href: string): void {
  if (href.split(/[\\/]/u).includes("..")) {
    throw new TypeError("Worker moduleURL must not contain parent directory segments");
  }
}
