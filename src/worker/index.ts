/**
 * Explicit worker-thread offload helpers.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * CPU-heavy work is never routed to workers automatically. Callers opt in by
 * pointing WorkJS at a module export that can run in a Node worker thread.
 */

import { Worker } from "node:worker_threads";
import type { TaskFn } from "../types/index.js";

interface WorkerReply<R> {
  ok: boolean;
  value?: R;
  error?: {
    name?: string;
    message: string;
    stack?: string;
  };
}

/** Creates a task function that executes a module export in a worker thread. */
export function offload<I, R>(
  moduleURL: string | URL,
  exportName: string,
  input: I
): TaskFn<R> {
  const moduleHref = moduleURL instanceof URL ? moduleURL.href : moduleURL;

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

      const onError = (err: Error) => {
        settle(() => reject(err));
      };

      const onExit = (code: number) => {
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
  const err = new Error(serialized?.message ?? "Worker task failed");
  err.name = serialized?.name ?? "WorkerTaskError";
  if (serialized?.stack !== undefined) err.stack = serialized.stack;
  return err;
}
