/**
 * Opt-in observability export helpers for WorkJS.
 *
 * @author Admilson B. F. Cossa
 *
 * Core WorkJS never imports remote telemetry clients. This module accepts a
 * caller-provided exporter and adds sampling plus a circuit breaker so telemetry
 * volume and exporter failures cannot take down application work.
 */

import type { Scope, TaskEvent, Unsubscribe } from "../types/index.js";

/** Export destination supplied by an application or companion package. */
export type TaskEventExporter = (event: TaskEvent) => void | Promise<void>;

/** Sampling modes supported by the opt-in export bridge. */
export type SamplingPolicy =
  | { mode: "off" }
  | { mode: "all" }
  | { mode: "head"; rate: number; random?: () => number }
  | { mode: "errors_and_slow"; slowThresholdMs: number };

/** Circuit breaker settings for exporter failure isolation. */
export interface ExporterCircuitBreakerOptions {
  failureThreshold?: number;
  openForMs?: number;
  now?: () => number;
}

/** Options used when attaching an exporter to a scope. */
export interface TelemetryExportOptions {
  sampling?: SamplingPolicy;
  circuitBreaker?: ExporterCircuitBreakerOptions;
}

/** Live attachment returned by `attachTelemetryExporter`. */
export interface TelemetryAttachment {
  unsubscribe(): void;
  exportedCount(): number;
  droppedCount(): number;
  state(): "closed" | "open" | "half_open";
}

/** Attaches a sampled, circuit-broken exporter to a scope event stream. */
export function attachTelemetryExporter(
  scope: Pick<Scope, "onEvent">,
  exporter: TaskEventExporter,
  opts: TelemetryExportOptions = {}
): TelemetryAttachment {
  const sampling = opts.sampling ?? { mode: "errors_and_slow", slowThresholdMs: 2_000 };
  const breaker = createExporterCircuitBreaker(exporter, opts.circuitBreaker ?? {});

  if (sampling.mode === "off") {
    return makeAttachment(() => undefined, breaker);
  }

  const headAccepted = sampling.mode === "head"
    ? (sampling.random ?? Math.random)() < sampling.rate
    : true;

  const unsubscribe = scope.onEvent((event) => {
    if (!shouldExport(event, sampling, headAccepted)) {
      breaker.drop();
      return;
    }
    void breaker.export(event);
  });

  return makeAttachment(unsubscribe, breaker);
}

function shouldExport(event: TaskEvent, sampling: SamplingPolicy, headAccepted: boolean): boolean {
  switch (sampling.mode) {
    case "all":
      return true;
    case "head":
      return headAccepted;
    case "errors_and_slow":
      return event.type === "task:failed"
        || event.type === "task:cancelled"
        || (event.type === "task:succeeded" && event.durationMs >= sampling.slowThresholdMs);
    /* v8 ignore next -- off mode returns before subscribing to scope events. */
    case "off":
      return false;
  }
}

function createExporterCircuitBreaker(
  exporter: TaskEventExporter,
  opts: ExporterCircuitBreakerOptions
) {
  const failureThreshold = opts.failureThreshold ?? 3;
  const openForMs = opts.openForMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let state: "closed" | "open" | "half_open" = "closed";
  let failures = 0;
  let openedUntil = 0;
  let exported = 0;
  let dropped = 0;

  return {
    async export(event: TaskEvent): Promise<void> {
      if (state === "open") {
        if (now() < openedUntil) {
          dropped++;
          return;
        }
        state = "half_open";
      }

      try {
        await exporter(event);
        exported++;
        failures = 0;
        state = "closed";
      } catch {
        dropped++;
        failures++;
        if (state === "half_open" || failures >= failureThreshold) {
          state = "open";
          openedUntil = now() + openForMs;
        }
      }
    },
    drop(): void {
      dropped++;
    },
    exportedCount(): number {
      return exported;
    },
    droppedCount(): number {
      return dropped;
    },
    state(): "closed" | "open" | "half_open" {
      return state;
    },
  };
}

function makeAttachment(
  unsubscribe: Unsubscribe,
  breaker: ReturnType<typeof createExporterCircuitBreaker>
): TelemetryAttachment {
  return {
    unsubscribe,
    exportedCount: () => breaker.exportedCount(),
    droppedCount: () => breaker.droppedCount(),
    state: () => breaker.state(),
  };
}
