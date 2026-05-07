/**
 * Installed package consumer smoke test.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This script packs the built package, installs the tarball into a temporary
 * consumer project, and imports the public subpaths from that installed copy.
 */

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tscCli = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const bunCli = await findExecutable(["bun.exe", "bun"], [join(homedir(), ".bun", "bin", "bun.exe")]);
const denoCli = await findExecutable(["deno.exe", "deno"], [join(homedir(), ".deno", "bin", "deno.exe")]);
const wranglerCli = await findExecutable(
  ["wrangler.cmd", "wrangler"],
  [
    join(ROOT, "node_modules", ".bin", "wrangler.cmd"),
    join(homedir(), "node_modules", ".bin", "wrangler.cmd"),
  ]
);

if (bunCli === null) throw new Error("Bun compatibility fixture requires a Bun executable.");
if (denoCli === null) throw new Error("Deno compatibility fixture requires a Deno executable.");
if (wranglerCli === null) throw new Error("Cloudflare Worker dry-run fixture requires Wrangler.");

const temp = await mkdtemp(join(tmpdir(), "workjs-consumer-"));

try {
  const { stdout } = await runNpm(["pack", "--json", "--pack-destination", temp], {
    cwd: ROOT,
    timeout: 120_000,
  });
  const [pack] = JSON.parse(stdout);
  const tarball = join(temp, pack.filename);

  await writeFile(join(temp, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  await runNpm([
    "install",
    "--ignore-scripts",
    tarball,
    "@opentelemetry/api@^1.9.1",
    "@trpc/server@11.17.0",
    "express@5.2.1",
    "fastify@5.8.5",
    "ai@6.0.175",
  ], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "smoke.mjs"), `
    import { run, work, group } from "@workjs/core";
    import { embedAll, streamWithBackpressure } from "@workjs/core/ai";
    import { attachTelemetryExporter } from "@workjs/core/observability";
    import { attachOpenTelemetry } from "@workjs/core/otel";
    import { offload } from "@workjs/core/worker";

    const result = await run.all([async () => "sdk", async () => "ok"]);
    const batch = await work([1, 2]).inParallel(2).do(async (item) => item * 2);
    const embedded = await embedAll(["a"], { embed: async (text) => [text.length] }, { concurrency: 1 });
    const streamed = [];
    for await (const item of streamWithBackpressure(["x"], async (input) => input.toUpperCase())) streamed.push(item);
    let exported = 0;
    const tracer = { startSpan: () => ({
      setAttribute() { return this; },
      addEvent() { return this; },
      recordException() {},
      setStatus() { return this; },
      end() {}
    }) };
    const meter = {
      createCounter: () => ({ add() {} }),
      createHistogram: () => ({ record() {} })
    };
    await group(async (task) => {
      await task(async (ctx) => {
        const attachment = attachTelemetryExporter(ctx.scope, () => { exported++; }, { sampling: { mode: "all" } });
        const otel = attachOpenTelemetry(ctx.scope, { tracer, meter });
        ctx.report({ message: "installed" });
        otel.unsubscribe();
        attachment.unsubscribe();
      });
    });

    if (result.join(":") !== "sdk:ok") throw new Error("root import failed");
    if (batch.results.join(":") !== "2:4") throw new Error("work import failed");
    if (embedded.results[0][0] !== 1) throw new Error("ai import failed");
    if (streamed.join(":") !== "X") throw new Error("ai stream helper failed");
    if (exported !== 1) throw new Error("observability import failed");
    if (typeof attachOpenTelemetry !== "function") throw new Error("otel import failed");
    if (typeof offload !== "function") throw new Error("worker import failed");
  `, "utf8");

  await execFileAsync(process.execPath, ["smoke.mjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "cjs-smoke.cjs"), `
    const { run, work } = require("@workjs/core");

    (async () => {
      const values = await run.all([async () => "cjs", async () => "ok"]);
      const output = await work([1, 2, 3]).inParallel(2).do(async (item) => item + 1);
      if (values.join(":") !== "cjs:ok") throw new Error("CommonJS root import failed");
      if (output.results.join(":") !== "2:3:4") throw new Error("CommonJS work import failed");
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `, "utf8");

  await execFileAsync(process.execPath, ["cjs-smoke.cjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "tsconfig.strict.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      lib: ["ES2022", "DOM"],
    },
    include: ["strict-smoke.ts"],
  }, null, 2), "utf8");

  await writeFile(join(temp, "strict-smoke.ts"), `
    import {
      ContextBagImpl,
      CostBudget,
      createContextKey,
      group,
      run,
      work,
      type CancelReason,
      type CancelledItem,
      type ItemError,
      type Settled,
      type TaskContext,
    } from "@workjs/core";
    import { embedAll, streamWithBackpressure } from "@workjs/core/ai";

    const RequestKey = createContextKey<{ requestId: string }>("request");

    const tuple: readonly [number, string] = await run.all([
      async () => 1,
      async () => "typed",
    ] as const);

    const value = await group(async (task) => {
      return await task(async (ctx: TaskContext) => {
        const request = ctx.context.get(RequestKey);
        return request?.requestId ?? "missing";
      });
    }, {
      context: new ContextBagImpl().with(RequestKey, { requestId: "strict" }),
    });

    const embedded = await embedAll(["abc"], {
      async embed(input: string) {
        return [input.length] as const;
      },
    });
    const streamed: string[] = [];
    for await (const item of streamWithBackpressure(["typed"], async (input) => input.toUpperCase())) streamed.push(item);

    if (tuple[0] !== 1 || tuple[1] !== "typed") throw new Error("tuple inference failed");
    if (value !== "strict") throw new Error("context inference failed");
    if (embedded.mode !== "fail") throw new Error("unexpected embedAll mode");
    if (embedded.results[0]?.[0] !== 3) throw new Error("AI helper inference failed");
    if (streamed[0] !== "TYPED") throw new Error("AI stream helper inference failed");

    const inferredVoid: void = await group(async () => {});
    void inferredVoid;
    // @ts-expect-error explicit group<string> bodies must return string.
    await group<string>(async () => {});

    await run.context.with(CostBudget, { spent: 0, limit: 1, unit: "USD" }, async () => {
      const snapshot = run.context.budget(CostBudget);
      if (snapshot === undefined) throw new Error("budget snapshot missing");
      // @ts-expect-error public budget snapshots are readonly.
      snapshot.spent = 1;
    });

    const failOutput: { mode: "fail"; results: number[] } = await work([1]).do(async (item) => item);
    // @ts-expect-error fail output has no item errors without narrowing.
    failOutput.errors;

    const continueOutput: { mode: "continue"; results: number[]; errors: ItemError[] } =
      await work([1]).onError("continue").do(async (item) => item);

    const collectOutput: { mode: "collect"; results: Settled<number>[] } =
      await work([1]).onError("collect").do(async (item) => item);

    const partialOutput: { mode: "fail"; results: number[] } | {
      mode: "partial";
      results: number[];
      errors: ItemError[];
      cancelled: CancelledItem[];
      reason?: CancelReason;
    } = await work([1]).onCancel("partial").do(async (item) => item);
    void continueOutput;
    void collectOutput;
    void partialOutput;
  `, "utf8");

  await execFileAsync(process.execPath, [tscCli, "--noEmit", "--project", "tsconfig.strict.json"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "bun-fixture.mjs"), `
    import { run } from "@workjs/core";

    const result = await run.all([async () => "bun", async () => "ok"]);
    if (result.join(":") !== "bun:ok") throw new Error("Bun runtime fixture failed");
  `, "utf8");

  await execFileAsync(bunCli, ["bun-fixture.mjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "deno-fixture.mjs"), `
    import { run } from "@workjs/core";

    const result = await run.all([async () => "deno", async () => "ok"]);
    if (result.join(":") !== "deno:ok") throw new Error("Deno runtime fixture failed");
  `, "utf8");

  await execFileAsync(denoCli, ["run", "--allow-read", "--allow-env", "--allow-sys", "deno-fixture.mjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "aws-fixture.mjs"), `
    import { work } from "@workjs/core";

    export async function handler(event) {
      const output = await work(event.records).inParallel(2).onError("continue").do(async (record) => ({
        id: record.id,
        bytes: record.body.length
      }));
      return { statusCode: 200, body: JSON.stringify({ processed: output.results.length }) };
    }

    const result = await handler({ records: [{ id: "a", body: "hello" }, { id: "b", body: "aws" }] });
    if (result.statusCode !== 200) throw new Error("AWS fixture status failed");
    if (JSON.parse(result.body).processed !== 2) throw new Error("AWS fixture body failed");
  `, "utf8");

  await writeFile(join(temp, "azure-fixture.mjs"), `
    import { run } from "@workjs/core";

    export async function handler(context, request) {
      const names = request.body.names;
      context.res = { status: 200, jsonBody: { greetings: await run.pool(2, names.map((name) => async () => "hello " + name)) } };
    }

    const context = {};
    await handler(context, { body: { names: ["azure", "functions"] } });
    if (context.res.status !== 200) throw new Error("Azure fixture status failed");
    if (context.res.jsonBody.greetings.join(":") !== "hello azure:hello functions") throw new Error("Azure fixture body failed");
  `, "utf8");

  await writeFile(join(temp, "next-fixture.mjs"), `
    import { run } from "@workjs/core";

    export async function POST(request) {
      const payload = await request.json();
      return Response.json({ query: payload.query, winner: await run.race([async () => "next"]) });
    }

    const response = await POST(new Request("https://example.test/api", { method: "POST", body: JSON.stringify({ query: "workjs" }) }));
    const json = await response.json();
    if (json.query !== "workjs" || json.winner !== "next") throw new Error("Next fixture failed");
  `, "utf8");

  await writeFile(join(temp, "express-fixture.mjs"), `
    import express from "express";
    import { request as httpRequest } from "node:http";
    import { run } from "@workjs/core";

    let disconnectCancelled = false;
    const app = express();
    app.use(express.json());
    app.post("/items", async (request, response, next) => {
      try {
        const items = request.body.items ?? [];
        const output = await run.pool(2, items.map((item) => async () => item.toUpperCase()));
        response.json({ output });
      } catch (err) {
        next(err);
      }
    });
    app.get("/disconnect", async (request, response) => {
      const disconnect = new AbortController();
      request.on("close", () => {
        disconnect.abort(new Error("client disconnected"));
      });

      try {
        await run.group(async (task) => {
          await task(async (ctx) => {
            const signal = AbortSignal.any([ctx.signal, disconnect.signal]);
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5_000);
              signal.addEventListener("abort", () => {
                clearTimeout(timer);
                disconnectCancelled = true;
                reject(signal.reason);
              }, { once: true });
            });
          }, { name: "express.disconnect" });
        });
        response.status(500).end("unexpected");
      } catch {
        if (!response.headersSent) response.status(499).end();
      }
    });

    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });

    try {
      const address = server.address();
      const response = await fetch(\`http://127.0.0.1:\${address.port}/items\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: ["express", "workjs"] }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("Express fixture status failed");
      if (body.output.join(":") !== "EXPRESS:WORKJS") throw new Error("Express fixture body failed");

      await new Promise((resolve) => {
        const req = httpRequest({
          hostname: "127.0.0.1",
          port: address.port,
          path: "/disconnect",
          method: "GET",
        });
        req.on("error", () => resolve());
        req.end();
        setTimeout(() => req.destroy(), 20);
      });

      for (let attempt = 0; attempt < 100 && !disconnectCancelled; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!disconnectCancelled) throw new Error("Express fixture did not cancel work on disconnect");
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => err === undefined ? resolve() : reject(err));
      });
    }
  `, "utf8");

  await writeFile(join(temp, "fastify-fixture.mjs"), `
    import Fastify from "fastify";
    import { work } from "@workjs/core";

    const app = Fastify();
    app.post("/items", async (request) => {
      const output = await work(request.body.items).inParallel(2).do(async (item) => item.toUpperCase());
      return { output: output.results };
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/items",
        payload: { items: ["fastify", "workjs"] },
      });
      const body = JSON.parse(response.body);
      if (response.statusCode !== 200) throw new Error("Fastify fixture status failed");
      if (body.output.join(":") !== "FASTIFY:WORKJS") throw new Error("Fastify fixture body failed");
    } finally {
      await app.close();
    }
  `, "utf8");

  await writeFile(join(temp, "trpc-fixture.mjs"), `
    import { initTRPC } from "@trpc/server";
    import { run } from "@workjs/core";

    const t = initTRPC.create();
    const router = t.router({
      values: t.procedure.query(async () => {
        return await run.all([
          async () => "trpc",
          async () => "workjs",
        ]);
      }),
    });

    const caller = router.createCaller({});
    const values = await caller.values();
    if (values.join(":") !== "trpc:workjs") throw new Error("tRPC fixture failed");
  `, "utf8");

  await writeFile(join(temp, "vercel-ai-fixture.mjs"), `
    import { streamText } from "ai";
    import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
    import { run } from "@workjs/core";

    let modelSawAbort = false;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        abortSignal.addEventListener("abort", () => {
          modelSawAbort = true;
        }, { once: true });
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: "hello" },
              { type: "text-delta", id: "0", delta: " workjs" },
              { type: "text-end", id: "0" },
              { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
            ],
            chunkDelayInMs: 25,
          }),
        };
      },
    });

    await run.group(async (task) => {
      await task(async (ctx) => {
        const result = streamText({
          model,
          prompt: "hello",
          abortSignal: ctx.signal,
          maxRetries: 0,
        });
        const iterator = result.textStream[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.value !== "hello") throw new Error("Vercel AI SDK stream did not yield first token");
        ctx.scope.cancel({ kind: "manual", tag: "client_stop" });
        try {
          await iterator.next();
        } catch {
          // The important contract is that WorkJS aborts the signal supplied to streamText.
        }
      }, { name: "vercel-ai.stream" });
    });

    if (!modelSawAbort) throw new Error("Vercel AI SDK fixture did not receive WorkJS cancellation");
  `, "utf8");

  for (const fixture of [
    "aws-fixture.mjs",
    "azure-fixture.mjs",
    "next-fixture.mjs",
    "express-fixture.mjs",
    "fastify-fixture.mjs",
    "trpc-fixture.mjs",
    "vercel-ai-fixture.mjs",
  ]) {
    await execFileAsync(process.execPath, [fixture], {
      cwd: temp,
      timeout: 120_000,
    });
  }

  await writeFile(join(temp, "browser-entry.mjs"), `
    import { group } from "@workjs/core";
    import { offload } from "@workjs/core/worker";
    globalThis.__workjsBrowserSmoke = [typeof group, typeof offload];
  `, "utf8");

  const browserBundle = await build({
    entryPoints: [join(temp, "browser-entry.mjs")],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const browserText = browserBundle.outputFiles[0].text;
  if (browserText.includes("node:async_hooks") || browserText.includes("node:worker_threads")) {
    throw new Error("Browser bundle pulled in Node-only WorkJS modules");
  }
  if (!browserText.includes("UnsupportedRuntimeError")) {
    throw new Error("Browser bundle did not resolve to the explicit unsupported runtime split");
  }

  await writeFile(join(temp, "cloudflare-worker.mjs"), `
    import { group } from "@workjs/core";

    export default {
      async fetch() {
        try {
          group(() => Promise.resolve("unexpected"));
          return new Response("unexpected", { status: 500 });
        } catch (err) {
          return Response.json({ name: err.name });
        }
      },
    };
  `, "utf8");

  await execCli(wranglerCli, [
    "deploy",
    "cloudflare-worker.mjs",
    "--name",
    "workjs-compat-smoke",
    "--dry-run",
    "--outdir",
    "wrangler-out",
    "--compatibility-date",
    "2026-05-07",
  ], {
    cwd: temp,
    timeout: 120_000,
  });

  const workerBundle = await readFile(join(temp, "wrangler-out", "cloudflare-worker.js"), "utf8");
  if (workerBundle.includes("node:async_hooks") || workerBundle.includes("node:worker_threads")) {
    throw new Error("Cloudflare Worker dry-run pulled in Node-only WorkJS modules");
  }
  if (!workerBundle.includes("UnsupportedRuntimeError")) {
    throw new Error("Cloudflare Worker dry-run did not resolve to the unsupported runtime split");
  }

  console.log(JSON.stringify({
    packageConsumer: "ok",
    runtimeFixtures: "ok",
    frameworkFixtures: "ok",
    frameworks: ["express", "fastify", "trpc", "next", "vercel-ai"],
    tarball: pack.filename,
  }));
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function findExecutable(names, fallbacks) {
  for (const file of fallbacks) {
    if (await exists(file)) return file;
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (await exists(file)) return file;
    }
  }

  return null;
}

async function execCli(executable, args, opts) {
  if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    return await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...args], opts);
  }
  return await execFileAsync(executable, args, opts);
}

async function runNpm(args, opts) {
  if (process.env.npm_execpath !== undefined) {
    return await execFileAsync(process.execPath, [process.env.npm_execpath, ...args], opts);
  }

  const npmCli = await findExecutable(["npm.cmd", "npm"], []);
  if (npmCli === null) throw new Error("npm executable not found on PATH.");
  return await execCli(npmCli, args, opts);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
