/**
 * WorkJS - current public engine surface.
 *
 * @author Admilson B. F. Cossa
 *
 * This module exports only the implemented core engine surface. Higher-level
 * namespaces described in the local concept docs are not exported until they
 * exist in source, tests, and build output.
 */

// Engine primitives
export { group, getCurrentScope } from "./engine/scope.js";
export type { TaskSpawner } from "./engine/scope.js";

// Run namespace
export { run } from "./run/index.js";

// Context
export { createContextKey, createBudget, ContextBagImpl } from "./engine/context.js";

// Types
export type {
  TaskFn, TaskHandle, TaskContext, TaskOpts, TaskKind, TaskId,
  Scope, ScopeOpts, ScopeId, ScopeSnapshot, TaskSnapshot,
  ContextKey, ContextBag, BudgetState,
  CancelReason, TaskEvent, Unsubscribe, ProgressReport, TaskLogger,
  Settled, Duration, TaskResults, WorkOutput, ItemError,
  RetryOpts, HedgeOpts, BreakerOpts, RunNamespace,
} from "./types/index.js";

// Errors
export { CancellationError, TimeoutError, BudgetExceededError, WorkAggregateError } from "./types/index.js";

// Built-in budget keys
export { CostBudget, TelemetryBudget, TokenBudget, LatencyBudget } from "./types/index.js";
