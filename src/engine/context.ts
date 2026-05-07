/**
 * ContextBag - immutable scope context store.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Context is the boundary for dependency injection and cooperative budgets.
 * Callers must install required values before task execution reaches the code
 * that consumes them.
 */

import type { ContextKey, ContextBag, BudgetState } from "../types/index.js";

const MAX_CONTEXT_KEY_NAME_LENGTH = 128;
const MAX_BUDGET_UNIT_LENGTH = 32;

interface BudgetCell {
  readonly kind: "budget-cell";
  readonly state: BudgetState;
}

/**
 * Immutable implementation of the WorkJS context bag.
 *
 * Values are copied into a fresh map on `with()` so a child scope can shadow a
 * parent value without mutating the parent context. This makes budget ownership
 * and replay behavior explicit at the scope boundary.
 */
export class ContextBagImpl implements ContextBag {
  private readonly entries: Map<string, unknown>;

  /** Creates a bag from an existing entry map or an empty map. */
  constructor(entries?: Map<string, unknown>) {
    this.entries = entries ?? new Map();
  }

  /** Reads a key from this bag, falling back to the key's default value. */
  get<T>(key: ContextKey<T>): T | undefined {
    if (this.entries.has(key.name)) {
      return toPublicValue(this.entries.get(key.name)) as T;
    }
    return key.defaultValue;
  }

  /** Reads a required key and fails immediately when the boundary contract is missing. */
  getOrThrow<T>(key: ContextKey<T>): T {
    const v = this.get(key);
    if (v === undefined) {
      throw new Error(`Context key "${key.name}" not set in scope`);
    }
    return v;
  }

  /** Returns a new bag with one key set or shadowed. */
  with<T>(key: ContextKey<T>, value: T): ContextBag {
    const next = new Map(this.entries);
    next.set(key.name, toStoredValue(value));
    return new ContextBagImpl(next);
  }

  /** Returns true only when this bag explicitly owns the key. */
  has<T>(key: ContextKey<T>): boolean {
    return this.entries.has(key.name);
  }

  /** Returns a stable snapshot of explicitly installed entries for inspection APIs. */
  entriesSnapshot(): ReadonlyArray<readonly [string, unknown]> {
    return [...this.entries.entries()].map(([key, value]) => [key, toPublicValue(value)] as const);
  }

  /** Reads the mutable budget cell used by the engine's accounting path. */
  getMutableBudget<T extends BudgetState>(key: ContextKey<T>): T | undefined {
    const value = this.entries.get(key.name);
    if (isBudgetCell(value)) return value.state as T;
    return undefined;
  }

  /** Returns the internal budget identity used to find the owning scope. */
  budgetIdentity<T extends BudgetState>(key: ContextKey<T>): unknown {
    const value = this.entries.get(key.name);
    return isBudgetCell(value) ? value : undefined;
  }
}

/**
 * Creates a typed context key for dependency injection through scopes.
 *
 * The key name is the stable storage identity, so callers should treat it as a
 * contract name rather than a display label. Default values are returned by
 * `ContextBag.get()` when no explicit value was installed.
 */
export function createContextKey<T>(name: string, defaultValue?: T): ContextKey<T> {
  assertContextKeyName(name);
  return {
    __brand: "ContextKey",
    __type: undefined as unknown as T,
    name,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

/**
 * Creates a budget context key for cooperative cost or quota accounting.
 *
 * The returned key does not allocate budget state by itself. A scope must still
 * install `{ spent, limit }` in its `ContextBag`. The optional unit is retained
 * on the key and used as the fallback unit for budget errors and summaries when
 * the installed state does not provide one.
 */
export function createBudget(name: string, opts: { unit?: string } = {}): ContextKey<BudgetState> {
  assertContextKeyName(name);
  if (opts.unit !== undefined) assertBudgetUnit(opts.unit);
  return {
    __brand: "ContextKey",
    __type: undefined as unknown as BudgetState,
    name,
    ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
  };
}

function toStoredValue(value: unknown): unknown {
  if (!isBudgetState(value)) return value;
  validateBudgetState(value);
  return {
    kind: "budget-cell",
    state: cloneBudgetState(value),
  } satisfies BudgetCell;
}

function toPublicValue(value: unknown): unknown {
  if (!isBudgetCell(value)) return value;
  return cloneBudgetState(value.state);
}

function cloneBudgetState(state: BudgetState): BudgetState {
  return {
    spent: state.spent,
    limit: state.limit,
    ...(state.unit !== undefined ? { unit: state.unit } : {}),
  };
}

function isBudgetCell(value: unknown): value is BudgetCell {
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "budget-cell"
    && isBudgetState((value as { state?: unknown }).state);
}

function isBudgetState(value: unknown): value is BudgetState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { limit?: unknown; spent?: unknown };
  return typeof candidate.limit === "number" && typeof candidate.spent === "number";
}

function validateBudgetState(state: BudgetState): void {
  assertFiniteNonNegative("budget.limit", state.limit);
  assertFiniteNonNegative("budget.spent", state.spent);
  if (state.spent > state.limit) {
    throw new RangeError("Budget spent cannot exceed limit at context boundary");
  }
  if (state.unit !== undefined) assertBudgetUnit(state.unit);
}

function assertContextKeyName(name: string): void {
  if (name.length === 0 || name.length > MAX_CONTEXT_KEY_NAME_LENGTH) {
    throw new RangeError(`Context key name must be 1-${MAX_CONTEXT_KEY_NAME_LENGTH} characters`);
  }
  if (name === "__proto__" || name === "constructor" || name === "prototype") {
    throw new RangeError(`Context key name "${name}" is reserved`);
  }
}

function assertBudgetUnit(unit: string): void {
  if (unit.length === 0 || unit.length > MAX_BUDGET_UNIT_LENGTH) {
    throw new RangeError(`Budget unit must be 1-${MAX_BUDGET_UNIT_LENGTH} characters`);
  }
}

function assertFiniteNonNegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}
