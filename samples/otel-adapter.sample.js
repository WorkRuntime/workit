/**
 * OpenTelemetry adapter sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Uses fake tracer and meter objects so the sample proves the real
 * `workjs/otel` import without requiring an OpenTelemetry collector.
 */

import { run } from "../dist/index.js";
import { attachOpenTelemetry } from "../dist/otel/index.js";

const spans = [];
const metrics = [];

const tracer = {
  startSpan(name) {
    const span = {
      name,
      events: [],
      ended: false,
      setAttribute() { return this; },
      addEvent(eventName) {
        this.events.push(eventName);
        return this;
      },
      recordException() {},
      setStatus(status) {
        this.status = status;
        return this;
      },
      end() {
        this.ended = true;
      },
    };
    spans.push(span);
    return span;
  },
};

const meter = {
  createCounter(name) {
    return {
      add(value, attributes) {
        metrics.push({ name, value, attributes });
      },
    };
  },
  createHistogram(name) {
    return {
      record(value, attributes) {
        metrics.push({ name, value, attributes });
      },
    };
  },
};

await run.scope(async (scope) => {
  const attachment = attachOpenTelemetry(scope, { tracer, meter });
  await scope.spawn(async (ctx) => {
    ctx.report({ pct: 1 });
    return "ok";
  }, { name: "sample.otel", kind: "io" });
  attachment.unsubscribe();
});

console.log(JSON.stringify({
  sample: "otel-adapter",
  spans: spans.map((span) => ({ name: span.name, ended: span.ended, events: span.events })),
  metricNames: metrics.map((metric) => metric.name),
}));
