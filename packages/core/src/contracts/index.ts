/**
 * Typed cancellation contract helpers for WorkIt tasks.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This subpath adds compile-time composition contracts around existing WorkIt
 * task functions. It records declared intent at API boundaries; it does not
 * prove that a task body observes `ctx.signal` at every await point.
 */

import { group, type TaskSpawner } from "../engine/scope.js";
import { run } from "../run/index.js";
import type { Duration, ScopeOpts, TaskFn, TaskHandle, TaskOpts } from "../types/index.js";

const contractBrand: unique symbol = Symbol("workit.contract.task");
const contractMetadata = new WeakMap<TaskFn<unknown>, TaskCancellationContract>();

/** Declared cancellation contract visible at typed composition boundaries. */
export type TaskCancellationContract =
  | { readonly kind: "cancellable" }
  | { readonly kind: "shielded"; readonly timeout: Duration; readonly discardReason?: string };

/** Task declared as normal cancellable WorkIt child work. */
export type CancellableTask<T> = TaskFn<T> & {
  readonly [contractBrand]: "cancellable";
};

/** Task declared as timeout-bounded shielded work. */
export type ShieldedTask<T> = TaskFn<T> & {
  readonly [contractBrand]: "shielded";
};

/** Spawner used by `typedGroup` to enforce task cancellation contracts. */
export interface TypedTaskSpawner {
  <T>(task: CancellableTask<T>, opts?: TaskOpts): TaskHandle<T>;

  /** Spawns cancellable background work that remains owned by the scope. */
  background<T>(task: CancellableTask<T>): TaskHandle<T>;

  /** Spawns explicit timeout-bounded shielded work. */
  shielded<T>(task: ShieldedTask<T>, opts?: TaskOpts): TaskHandle<T>;
}

/** Declares a WorkIt task as ordinary cancellable child work. */
export function cancellable<T>(task: TaskFn<T>): CancellableTask<T> {
  return brandTask(task, "cancellable", { kind: "cancellable" });
}

/** Declares a task as shielded by WorkIt's timeout-bounded uncancellable wrapper. */
export function shielded<T>(task: TaskFn<T>, opts: { timeout: Duration }): ShieldedTask<T> {
  return brandTask(run.uncancellable(task, opts), "shielded", {
    kind: "shielded",
    timeout: opts.timeout,
  });
}

/** Converts cancellable work into explicit shielded work with a named discard reason. */
export function discardCancellation<T>(
  task: CancellableTask<T>,
  discardReason: string,
  opts: { timeout: Duration },
): ShieldedTask<T> {
  assertDiscardReason(discardReason);
  return brandTask(run.uncancellable(task, opts), "shielded", {
    kind: "shielded",
    timeout: opts.timeout,
    discardReason,
  });
}

/** Opens a WorkIt group whose normal spawner accepts only declared cancellable tasks. */
export async function typedGroup<R>(
  body: (task: TypedTaskSpawner) => Promise<R>,
  opts: ScopeOpts = {},
): Promise<R> {
  return await group(async (task) => body(createTypedSpawner(task)), opts);
}

/** Returns the declared task cancellation contract, when one was declared. */
export function getTaskContract(task: TaskFn<unknown>): TaskCancellationContract | undefined {
  return contractMetadata.get(task);
}

/** Reports whether a task was declared through `cancellable(...)`. */
export function isCancellableTask<T>(task: TaskFn<T>): task is CancellableTask<T> {
  return contractMetadata.get(task)?.kind === "cancellable";
}

/** Reports whether a task was declared through `shielded(...)` or `discardCancellation(...)`. */
export function isShieldedTask<T>(task: TaskFn<T>): task is ShieldedTask<T> {
  return contractMetadata.get(task)?.kind === "shielded";
}

function createTypedSpawner(task: TaskSpawner): TypedTaskSpawner {
  const typed = Object.assign(
    <T>(fn: CancellableTask<T>, opts?: TaskOpts) => task(fn, opts),
    {
      background: <T>(fn: CancellableTask<T>) => task.background(fn),
      shielded: <T>(fn: ShieldedTask<T>, opts?: TaskOpts) => task(fn, opts),
    },
  );
  return typed;
}

function brandTask<T, K extends "cancellable" | "shielded">(
  task: TaskFn<T>,
  kind: K,
  metadata: TaskCancellationContract,
): TaskFn<T> & { readonly [contractBrand]: K } {
  Object.defineProperty(task, contractBrand, {
    configurable: false,
    enumerable: false,
    value: kind,
    writable: false,
  });
  contractMetadata.set(task as TaskFn<unknown>, metadata);
  return task as TaskFn<T> & { readonly [contractBrand]: K };
}

function assertDiscardReason(reason: string): void {
  if (reason.trim().length === 0) {
    throw new Error("discardCancellation requires a non-empty reason");
  }
}
