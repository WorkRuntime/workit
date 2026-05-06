/**
 * ContextBag - immutable scope context store.
 *
 * @author Admilson B. F. Cossa
 *
 * Implements `doc.md` section 3.7 and the budget keys from `doc-extensions.md`
 * section 2. Context is the boundary for dependency injection and cooperative
 * budgets; callers must install required values before task execution reaches
 * the code that consumes them.
 */

import type { ContextKey, ContextBag, BudgetState } from "../types/index.js";

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
      return this.entries.get(key.name) as T;
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
    next.set(key.name, value);
    return new ContextBagImpl(next);
  }

  /** Returns true only when this bag explicitly owns the key. */
  has<T>(key: ContextKey<T>): boolean {
    return this.entries.has(key.name);
  }

  /** Returns a stable snapshot of explicitly installed entries for inspection APIs. */
  entriesSnapshot(): ReadonlyArray<readonly [string, unknown]> {
    return [...this.entries.entries()];
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
  return {
    __brand: "ContextKey",
    __type: undefined as unknown as BudgetState,
    name,
    ...(opts.unit !== undefined ? { unit: opts.unit } : {}),
  };
}
