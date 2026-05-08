/**
 * Minimal behavioral baselines for unsignaled promise-helper patterns.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Each baseline below avoids a runtime dependency. The point is to compare the
 * unsignaled semantics the article calls out, not to claim these are complete
 * clones of the corresponding npm packages:
 *
 *   p-limit-style semaphore -- no automatic sibling-failure propagation.
 *   retry loop             -- retry counter with delay. Sleep is not signal-aware.
 *   timeout wrapper        -- wraps a Promise with a timeout. Returns a Promise,
 *                            not a composable TaskFn.
 *
 * These behavioral baselines are not bug-for-bug clones; they are the smallest
 * implementation of the specific behavior under comparison. If an upstream
 * library feature closes one of these gaps for the exact scenario being tested,
 * update this file and the article together.
 */

/**
 * pLimitLike(N) -- semaphore. Returns a wrapper `(fn) => Promise<T>` that
 * runs at most N concurrently. Has no cancellation. If a wrapped fn rejects,
 * queued ones still run.
 */
export function pLimitLike(N) {
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < N && queue.length > 0) {
      const next = queue.shift();
      active++;
      Promise.resolve()
        .then(next.run)
        .then(
          (value) => { active--; next.resolve(value); drain(); },
          (err)   => { active--; next.reject(err); drain(); },
        );
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ run: fn, resolve, reject });
      drain();
    });
}

/**
 * signalUnawareRetryLike(fn, { retries, minDelay }) -- retries on rejection up to `retries`
 * times. Sleep between attempts uses raw setTimeout -- NOT signal-aware. If the
 * caller wants to abort, the in-flight sleep does not see it.
 */
export async function signalUnawareRetryLike(fn, { retries = 3, minDelay = 100 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, minDelay));
    }
  }
  throw lastErr;
}

/**
 * promiseTimeoutLike(promise, ms) -- rejects with TimeoutError after ms. Does NOT
 * abort the underlying work. The promise keeps running. There is no signal
 * to thread, so any I/O the body started continues.
 */
export class PTimeoutError extends Error {
  constructor(ms) {
    super(`Promise timed out after ${ms} milliseconds`);
    this.name = "TimeoutError";
  }
}
export function promiseTimeoutLike(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PTimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Stamped now() relative to a t0 captured at module-import time. */
export function makeClock() {
  const t0 = Date.now();
  return {
    t: () => Date.now() - t0,
    fmt: () => `t=${(Date.now() - t0).toString().padStart(5)}ms`,
  };
}

/** signal-aware sleep used by the WorkIt-side bench bodies. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** signal-UNAWARE sleep -- used inside native-baseline bodies on purpose. */
export function naiveSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Track when a body actually settled so we can prove who kept running. */
export function makeProbe(name) {
  return {
    name,
    startedAt: -1,
    settledAt: -1,
    settledAs: "pending",     // "fulfilled" | "rejected" | "cancelled" | "pending"
    signalAbortedAt: -1,
    deferRanAt: -1,
  };
}

export function jsonReplacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}
