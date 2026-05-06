/**
 * OTel-shaped logging bridge sample.
 *
 * @author Admilson B. F. Cossa
 *
 * Runs against the compiled package. WorkJS core does not import OpenTelemetry;
 * applications can adapt task log events to an OTel log exporter at the edge.
 */

import assert from "node:assert/strict";
import { run } from "../dist/index.js";
import { attachTelemetryExporter } from "../dist/observability/index.js";

const records = await run.scope(async (scope) => {
  const exported = [];
  const attachment = attachTelemetryExporter(scope, (event) => {
    const record = toOtelLogRecord(event);
    if (record !== null) exported.push(record);
  }, {
    sampling: { mode: "all" },
  });

  await scope.spawn(async (ctx) => {
    ctx.log.info("sample.import.started", { importer: "catalog" });
    ctx.log.warn("sample.import.skipped", { reason: "duplicate" });
    return "ok";
  }, {
    name: "sample.import",
    kind: "io",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  attachment.unsubscribe();
  return exported;
}, {
  name: "logging.sample",
});

assert.ok(records.some((record) => record.body === "sample.import.started"));
assert.ok(records.some((record) => record.body === "sample.import.skipped"));
assert.ok(records.every((record) => record.instrumentationScope.name === "workjs"));

process.stdout.write(`${JSON.stringify({
  sample: "logging-otel-bridge",
  otelImported: false,
  records: records.length,
  bodies: records.map((record) => record.body),
})}\n`);

function toOtelLogRecord(event) {
  if (event.type !== "task:progress" || typeof event.message !== "string") {
    return null;
  }

  const data = event.data;
  if (typeof data !== "object" || data === null || !("logLevel" in data)) {
    return null;
  }

  return {
    timestamp: event.at,
    severityText: String(data.logLevel).toUpperCase(),
    body: event.message,
    attributes: {
      "workjs.task.id": event.taskId,
      ...("fields" in data && typeof data.fields === "object" && data.fields !== null
        ? data.fields
        : {}),
    },
    instrumentationScope: {
      name: "workjs",
    },
  };
}
