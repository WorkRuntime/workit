/**
 * Local Node runtime API for the WorkIt examples site.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from "node:http";
import { runners } from "./runners.mjs";

const PORT = Number.parseInt(process.env.WORKIT_SITE_RUNTIME_PORT ?? "4176", 10);

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    sendJson(response, 500, {
      error: "runtime_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`workit-site-runtime listening on http://127.0.0.1:${PORT}\n`);
});

async function route(request, response) {
  if (!request.url) {
    sendJson(response, 400, { error: "missing_url" });
    return;
  }

  if (request.method === "OPTIONS") {
    writeCors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, runtime: "node", package: "@workit/core" });
    return;
  }

  const match = /^\/api\/examples\/([^/]+)\/run$/.exec(url.pathname);
  if (!match) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const id = decodeURIComponent(match[1]);
  const runner = runners[id];

  if (!runner) {
    sendJson(response, 404, { error: "unknown_example", id });
    return;
  }

  const result = await runner();
  sendJson(response, 200, {
    source: "live-node",
    ...result,
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  writeCors(response);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeCors(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}
