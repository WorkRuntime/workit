/**
 * EventBus - propagating event stream with cost-aware emission.
 *
 * @author Admilson B. F. Cossa
 *
 * Key properties:
 *   - Zero dispatch work when no handlers are subscribed (fast path).
 *   - Bubbles to parent bus (one handler at the root sees the whole tree).
 *   - Telemetry budget gate: emit() drops silently after limit, never throws.
 *   - Handler exceptions are caught and discarded (observers must not affect tasks).
 */

import type { TaskEvent, Unsubscribe, BudgetState, ContextBag } from "../types/index.js";
import { TelemetryBudget } from "../types/index.js";

/**
 * Scope-local event stream with parent bubbling.
 *
 * `EventBus` is intentionally not an exporter. It is the in-process event spine
 * used by scopes and tests. Remote telemetry belongs in a separate opt-in layer
 * so WorkJS keeps zero network behavior and zero telemetry bill by default.
 */
export class EventBus {
  private handlers: Set<(e: TaskEvent) => void> = new Set();
  private parent: EventBus | null;
  private droppedCount = 0;
  private overrunWarned = false;

  /** Creates a bus that optionally bubbles dispatched events to a parent bus. */
  constructor(parent: EventBus | null = null) {
    this.parent = parent;
  }

  /** Registers an event handler and returns its unsubscribe function. */
  on(handler: (e: TaskEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Emits a typed event through this bus and its parents.
   *
   * This honors `TelemetryBudget` from the supplied context bag:
   * - no handlers anywhere up the chain: return immediately
   * - budget present and exhausted: drop the event and count it
   * - first drop: emit one synthetic progress warning
   * - handler throws: isolate the error and continue
   *
   * Telemetry budget exhaustion never affects task execution.
   */
  emit(event: TaskEvent, ctx: ContextBag | null = null): void {
    if (!this.hasAnyHandler()) return;

    if (ctx) {
      const budget = ctx.get(TelemetryBudget);
      if (budget && budget.spent >= budget.limit) {
        if (!this.overrunWarned) {
          this.overrunWarned = true;
          this.emitOverrunWarning(budget);
        }
        this.droppedCount++;
        return;
      }
      if (budget) budget.spent++;
    }

    this.dispatch(event);
  }

  private dispatch(event: TaskEvent): void {
    for (const h of this.handlers) {
      try { h(event); } catch { /* observer errors must not affect tasks */ }
    }
    if (this.parent) this.parent.dispatch(event);
  }

  private hasAnyHandler(): boolean {
    if (this.handlers.size > 0) return true;
    return this.parent ? this.parent.hasAnyHandler() : false;
  }

  private emitOverrunWarning(budget: BudgetState): void {
    // Synthesize a single progress event flagging the overrun.
    // We dispatch directly (bypass budget gate to avoid recursion).
    this.dispatch({
      type: "task:progress",
      taskId: "telemetry-bus" as unknown as import("../types/index.js").TaskId,
      message: "telemetry budget exceeded",
      data: { telemetry_budget_exceeded: true, limit: budget.limit, spent: budget.spent },
      at: Date.now(),
    });
  }

  /** Returns events dropped by this bus because the telemetry budget was exhausted. */
  droppedEventCount(): number {
    return this.droppedCount;
  }
}
