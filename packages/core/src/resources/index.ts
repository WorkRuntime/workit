/**
 * Resource ownership helpers built on WorkIt scope cleanup.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * These helpers compose existing `ctx.defer()` and `scope.defer()` behavior.
 * They do not introduce a second cleanup owner.
 */

import type { CleanupContext, CleanupOpts, Scope, TaskContext, TaskFn } from "../types/index.js";

/** Acquires a resource inside a WorkIt task context. */
export type ResourceAcquire<R> = (ctx: TaskContext) => R | Promise<R>;

/** Releases a resource through WorkIt's bounded cleanup context. */
export type ResourceRelease<R> = (resource: R, ctx: CleanupContext) => void | Promise<void>;

/** Lazy resource handle supplied to `bracketLazy` users. */
export interface LazyResource<R> {
  get(): Promise<R>;
  acquired(): boolean;
}

interface SharedState<R> {
  hasResource: boolean;
  resource?: R;
  acquirePromise?: Promise<R>;
  releaseRegistered: boolean;
}

/** Registers an already acquired scope-level resource for LIFO cleanup. */
export function scopeAcquire<R>(
  scope: Scope,
  resource: R,
  release: ResourceRelease<R>,
  opts: CleanupOpts = {},
): R {
  scope.defer((ctx) => release(resource, ctx), opts);
  return resource;
}

/** Acquires a resource only if the task body calls `resource.get()`. */
export function bracketLazy<R, T>(
  acquire: ResourceAcquire<R>,
  use: (resource: LazyResource<R>, ctx: TaskContext) => T | Promise<T>,
  release: ResourceRelease<R>,
  opts: CleanupOpts = {},
): TaskFn<T> {
  return async (ctx) => {
    let hasResource = false;
    let resource: R | undefined;
    let acquirePromise: Promise<R> | undefined;

    const lazy: LazyResource<R> = {
      async get() {
        if (hasResource) return resource as R;
        if (acquirePromise !== undefined) return await acquirePromise;

        acquirePromise = Promise.resolve()
          .then(() => acquire(ctx))
          .then((value) => {
            resource = value;
            hasResource = true;
            ctx.defer((cleanupCtx) => release(value, cleanupCtx), opts);
            return value;
          }, (error: unknown) => {
            acquirePromise = undefined;
            throw error;
          });

        return await acquirePromise;
      },
      acquired() {
        return hasResource;
      },
    };

    return await use(lazy, ctx);
  };
}

/** Shares one scope-owned resource across every task that uses the returned wrapper. */
export function bracketShared<R, T>(
  acquire: ResourceAcquire<R>,
  use: (resource: R, ctx: TaskContext) => T | Promise<T>,
  release: ResourceRelease<R>,
  opts: CleanupOpts = {},
): TaskFn<T> {
  const states = new WeakMap<Scope, SharedState<R>>();

  return async (ctx) => {
    const state = getSharedState(states, ctx.scope);
    const resource = await getSharedResource(state, ctx, acquire, release, opts);
    return await use(resource, ctx);
  };
}

function getSharedState<R>(states: WeakMap<Scope, SharedState<R>>, scope: Scope): SharedState<R> {
  const existing = states.get(scope);
  if (existing !== undefined) return existing;

  const created: SharedState<R> = {
    hasResource: false,
    releaseRegistered: false,
  };
  states.set(scope, created);
  return created;
}

async function getSharedResource<R>(
  state: SharedState<R>,
  ctx: TaskContext,
  acquire: ResourceAcquire<R>,
  release: ResourceRelease<R>,
  opts: CleanupOpts,
): Promise<R> {
  if (state.hasResource) return state.resource as R;
  if (state.acquirePromise !== undefined) return await state.acquirePromise;

  state.acquirePromise = Promise.resolve()
    .then(() => acquire(ctx))
    .then((resource) => {
      state.resource = resource;
      state.hasResource = true;
      /* v8 ignore else -- registration is false until the first successful acquisition in this state. */
      if (!state.releaseRegistered) {
        state.releaseRegistered = true;
        ctx.scope.defer((cleanupCtx) => release(resource, cleanupCtx), opts);
      }
      return resource;
    }, (error: unknown) => {
      delete state.acquirePromise;
      throw error;
    });

  return await state.acquirePromise;
}
