/**
 * Explicit worker-thread offload helpers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * CPU-heavy work is never routed to workers automatically. Callers opt in by
 * pointing WorkJS at a local, application-controlled module export that can run
 * in a Node worker thread.
 */

import { Worker } from "node:worker_threads";
import type { TaskFn } from "../types/index.js";
import { normalizeWorkerModuleURL } from "./module-url.js";

interface WorkerReply<R> {
  ok: boolean;
  value?: R;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

/**
 * Creates a task function that executes a local module export in a worker thread.
 *
 * `moduleURL` must be a file URL or path controlled by the application at build
 * time. WorkJS rejects inline and remote URL schemes because worker offload is
 * an execution boundary, not a user-input module loader.
 */
export function offload<I, R>(
  moduleURL: string | URL,
  exportName: string,
  input: I
): TaskFn<R> {
  const moduleHref = normalizeWorkerModuleURL(moduleURL);
  assertPlainStructuredCloneData(input);

  return async (ctx) => {
    return await new Promise<R>((resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(ctx.signal.reason);
        return;
      }

      const worker = new Worker(new URL("./runner.js", import.meta.url), {
        workerData: { moduleURL: moduleHref, exportName, input },
      });

      let settled = false;

      const cleanup = () => {
        ctx.signal.removeEventListener("abort", onAbort);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };

      const settle = (fn: () => void) => {
        /* v8 ignore next -- guards against duplicate terminal worker events. */
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onAbort = () => {
        settle(() => {
          void worker.terminate();
          reject(ctx.signal.reason);
        });
      };

      const onMessage = (reply: WorkerReply<R>) => {
        settle(() => {
          if (reply.ok) resolve(reply.value as R);
          else reject(toError(reply.error));
        });
      };

      /* v8 ignore next -- module failures are reported by the runner message path. */
      const onError = (err: Error) => {
        settle(() => reject(err));
      };

      const onExit = (code: number) => {
        /* v8 ignore next -- normal zero exits are settled through the message path. */
        if (code !== 0) {
          settle(() => reject(new Error(`Worker stopped with exit code ${code}`)));
        }
      };

      ctx.signal.addEventListener("abort", onAbort, { once: true });
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
  };
}

function toError(serialized: WorkerReply<unknown>["error"]): Error {
  /* v8 ignore next -- the runner always serializes a message for failed replies. */
  const err = new Error(serialized?.message ?? "Worker task failed");
  err.name = serialized?.name ?? "WorkerTaskError";
  if (serialized?.stack !== undefined) err.stack = serialized.stack;
  return err;
}

function assertPlainStructuredCloneData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint") return;
  if (type === "symbol" || type === "function") {
    throw new TypeError("Worker offload input must be plain structured-clone data");
  }

  const object = value as object;
  if (seen.has(object)) return;
  seen.add(object);

  if (isCloneSafeBuiltIn(object)) return;
  if (Array.isArray(object)) {
    for (const item of object) assertPlainStructuredCloneData(item, seen);
    return;
  }
  if (object instanceof Map) {
    for (const [key, item] of object) {
      assertPlainStructuredCloneData(key, seen);
      assertPlainStructuredCloneData(item, seen);
    }
    return;
  }
  if (object instanceof Set) {
    for (const item of object) assertPlainStructuredCloneData(item, seen);
    return;
  }

  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("Worker offload input must be plain structured-clone data");
  }
  for (const item of Object.values(object as Record<string, unknown>)) {
    assertPlainStructuredCloneData(item, seen);
  }
}

function isCloneSafeBuiltIn(value: object): boolean {
  return value instanceof Date
    || value instanceof RegExp
    || value instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
    || ArrayBuffer.isView(value);
}
