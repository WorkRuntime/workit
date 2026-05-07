/**
 * CI-safe context extension performance gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This gate exercises the public ContextBag contract from the compiled package.
 * It protects the hot boundary where scopes shadow context values: adding a new
 * value to an already large context must not clone the full visible context on
 * every call. Snapshotting remains intentionally O(N) because it is an
 * inspection path, not the runtime extension path.
 */

import { performance } from "node:perf_hooks";
import { ContextBagImpl, createContextKey } from "../dist/index.js";

const BASE_KEYS = Number.parseInt(process.env.WORKJS_CONTEXT_BASE_KEYS ?? "5000", 10);
const SHADOW_WRITES = Number.parseInt(process.env.WORKJS_CONTEXT_SHADOW_WRITES ?? "500", 10);
const MAX_SHADOW_MS = Number.parseInt(process.env.WORKJS_CONTEXT_MAX_SHADOW_MS ?? "75", 10);

let context = new ContextBagImpl();
for (let i = 0; i < BASE_KEYS; i++) {
  context = context.with(createContextKey(`context.perf.base.${i}`), i);
}

const startedAt = performance.now();
for (let i = 0; i < SHADOW_WRITES; i++) {
  context = context.with(createContextKey(`context.perf.shadow.${i}`), i);
}
const shadowMs = performance.now() - startedAt;

const firstBase = context.get(createContextKey("context.perf.base.0"));
const lastBase = context.get(createContextKey(`context.perf.base.${BASE_KEYS - 1}`));
const lastShadow = context.get(createContextKey(`context.perf.shadow.${SHADOW_WRITES - 1}`));

if (firstBase !== 0 || lastBase !== BASE_KEYS - 1 || lastShadow !== SHADOW_WRITES - 1) {
  throw new Error("Context performance gate lost visible context values");
}

if (shadowMs > MAX_SHADOW_MS) {
  throw new Error(
    `Context extension is too expensive: ${shadowMs.toFixed(2)}ms > ${MAX_SHADOW_MS}ms ` +
      `for ${SHADOW_WRITES} writes over ${BASE_KEYS} visible keys`
  );
}

console.log(JSON.stringify({
  contextPerformance: "ok",
  baseKeys: BASE_KEYS,
  shadowWrites: SHADOW_WRITES,
  shadowMs: Math.round(shadowMs * 100) / 100,
  maxShadowMs: MAX_SHADOW_MS,
}));
