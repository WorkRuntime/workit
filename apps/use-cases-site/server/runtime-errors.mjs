/**
 * Runtime API error serialization helpers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

const publicRuntimeFailureMessage = "An internal error occurred.";

/** Return the safe public response for an unexpected runtime failure. */
export function runtimeFailureResponse() {
  return {
    error: "runtime_failed",
    message: publicRuntimeFailureMessage,
  };
}

/** Return a server-side diagnostic string that is never sent in HTTP responses. */
export function runtimeFailureLogLine(error) {
  const detail = error instanceof Error
    ? error.stack ?? error.message
    : String(error);

  return `runtime_failed: ${detail}\n`;
}
