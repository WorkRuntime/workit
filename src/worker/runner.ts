/**
 * Worker-thread runner for explicit WorkJS offload tasks.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from "node:worker_threads";

interface WorkerRequest {
  moduleURL: string;
  exportName: string;
  input: unknown;
}

const port = parentPort;
if (port === null) throw new Error("WorkJS worker runner requires parentPort");

const request = workerData as WorkerRequest;

try {
  const mod = await import(request.moduleURL) as Record<string, unknown>;
  const fn = mod[request.exportName];
  if (typeof fn !== "function") {
    throw new TypeError(`Worker export "${request.exportName}" is not a function`);
  }
  const value = await fn(request.input);
  port.postMessage({ ok: true, value });
} catch (err) {
  port.postMessage({ ok: false, error: serializeError(err) });
}

function serializeError(err: unknown): { name?: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  return { message: String(err) };
}
