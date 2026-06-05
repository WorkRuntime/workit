/**
 * WorkIt - current public engine surface.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This module exports only runtime surfaces that exist in source, tests, and
 * build output.
 */

// Engine primitives
export { group, getCurrentScope } from "./engine/scope.js";
export type { TaskSpawner } from "./engine/scope.js";

// Run namespace
export { run } from "./run/index.js";

// Work builder
export { work } from "./work/index.js";

// Tree rendering
export { renderTree } from "./engine/tree.js";

// Context
export { createContextKey, createBudget, ContextBagImpl } from "./engine/context.js";

// Types
export type {
  TaskFn, TaskHandle, TaskContext, TaskOpts, TaskKind, TaskId,
  Scope, ScopeOpts, ScopeId, ScopeSnapshot, TaskSnapshot,
  ContextKey, ContextBag, BudgetState,
  CancelReason, TaskEvent, Unsubscribe, ProgressReport, TaskLogger,
  Settled, Duration, TaskResults, WorkOutput, ItemError, CancelledItem,
  WorkProgressEvent, WorkItemDoneEvent,
  RetryOpts, HedgeOpts, BreakerOpts, CleanupContext, CleanupOpts, DetachedOpts,
  RunNamespace, WorkFactory, WorkBuilder, TreeOpts,
} from "./types/index.js";

// Errors
export { CancellationError, TimeoutError, BudgetExceededError, WorkAggregateError } from "./types/index.js";

// Built-in budget keys
export { CostBudget, TelemetryBudget, TokenBudget, LatencyBudget } from "./types/index.js";
