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
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tscCli = require.resolve("typescript/bin/tsc");
const wranglerJsCli = require.resolve("wrangler/bin/wrangler.js");
const bunCli = await findExecutable(["bun.exe", "bun"], [join(homedir(), ".bun", "bin", "bun.exe")]);
const denoCli = await findExecutable(["deno.exe", "deno"], [join(homedir(), ".deno", "bin", "deno.exe")]);
const wranglerCli = await findExecutable(
  ["wrangler.cmd", "wrangler"],
  [
    wranglerJsCli,
    join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
    join(ROOT, "node_modules", ".bin", "wrangler.cmd"),
    join(homedir(), "node_modules", ".bin", "wrangler.cmd"),
  ]
);

if (bunCli === null) throw new Error("Bun compatibility fixture requires a Bun executable.");
if (denoCli === null) throw new Error("Deno compatibility fixture requires a Deno executable.");
if (wranglerCli === null) throw new Error("Cloudflare Worker dry-run fixture requires Wrangler.");

const temp = await mkdtemp(join(tmpdir(), "workit-consumer-"));

try {
  const { stdout } = await runNpm(["pack", "--json", "--pack-destination", temp], {
    cwd: ROOT,
    timeout: 120_000,
  });
  const [pack] = JSON.parse(stdout);
  const tarball = join(temp, pack.filename);

  await writeFile(join(temp, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  await runNpm(["install", "--ignore-scripts", tarball], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "otel-no-peer.mjs"), `
    import { attachOpenTelemetry } from "@workit/core/otel";

    try {
      attachOpenTelemetry({ onEvent: () => () => {} });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("To use @workit/core/otel, install:")) throw err;
      if (!message.includes("npm install @opentelemetry/api")) throw err;
      process.exit(0);
    }

    throw new Error("OTel subpath should explain the missing optional peer dependency.");
  `, "utf8");

  await execFileAsync(process.execPath, ["otel-no-peer.mjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "otel-no-peer.cjs"), `
    const { attachOpenTelemetry } = require("@workit/core/otel");

    try {
      attachOpenTelemetry({ onEvent: () => () => {} });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("To use @workit/core/otel, install:")) throw err;
      if (!message.includes("npm install @opentelemetry/api")) throw err;
      process.exit(0);
    }

    throw new Error("OTel CommonJS subpath should explain the missing optional peer dependency.");
  `, "utf8");

  await execFileAsync(process.execPath, ["otel-no-peer.cjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await runNpm([
    "install",
    "--ignore-scripts",
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
    import { run, work, group } from "@workit/core";
    import { ActivitySerializationError, createFileActivityStore, createMemoryActivityStore, runActivity } from "@workit/core/activity";
    import { analyzeReceipt, verifyReceipt, verifySourceProtocol } from "@workit/core/analysis";
    import { AgentCapabilityError, embedAll, runAgent, streamWithBackpressure } from "@workit/core/ai";
    import { cancellable, getTaskContract, shielded, typedGroup } from "@workit/core/contracts";
    import { cleanupHang, runFaultScenario } from "@workit/core/fault";
    import { createMemoryReceiptLedger, createPostgresReceiptLedger, createSqliteReceiptLedger } from "@workit/core/ledger";
    import { attachTelemetryExporter } from "@workit/core/observability";
    import { attachOpenTelemetry } from "@workit/core/otel";
    import { buildReceipt } from "@workit/core/replay";
    import { bracketLazy } from "@workit/core/resources";
    import { planTimePolicy } from "@workit/core/time-policy";
    import { offload } from "@workit/core/worker";

    const result = await run.all([async () => "sdk", async () => "ok"]);
    const batch = await work([1, 2]).inParallel(2).do(async (item) => item * 2);
    const embedded = await embedAll(["a"], { embed: async (text) => [text.length] }, { concurrency: 1 });
    let denied = false;
    await runAgent(async (agent) => {
      try {
        await agent.tool("write", undefined, async () => "unexpected", { capability: "repo:write" });
      } catch (err) {
        denied = err instanceof AgentCapabilityError;
      }
    }, { authority: { allowedCapabilities: ["repo:read"] } });
    const streamed = [];
    for await (const item of streamWithBackpressure(["x"], async (input) => input.toUpperCase())) streamed.push(item);
    let exported = 0;
    let lazyAcquired = 0;
    const typedValue = await typedGroup(async (spawn) => await spawn(cancellable(async () => "contracts")));
    const typedShield = shielded(async () => "shield", { timeout: 100 });
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
      await task(bracketLazy(
        async () => {
          lazyAcquired++;
          return "resource";
        },
        async (resource) => await resource.get(),
        async () => undefined,
      ));
    });

    if (result.join(":") !== "sdk:ok") throw new Error("root import failed");
    if (batch.results.join(":") !== "2:4") throw new Error("work import failed");
    if (embedded.results[0][0] !== 1) throw new Error("ai import failed");
    if (!denied) throw new Error("AI authority import failed");
    if (streamed.join(":") !== "X") throw new Error("ai stream helper failed");
    if (exported !== 1) throw new Error("observability import failed");
    if (typeof attachOpenTelemetry !== "function") throw new Error("otel import failed");
    if (typedValue !== "contracts") throw new Error("contracts import failed");
    if (getTaskContract(typedShield).kind !== "shielded") throw new Error("contracts metadata failed");
    const activityStore = createMemoryActivityStore();
    const activity = await group(async (task) => task(runActivity(
      activityStore,
      { activityId: "consumer-activity", input: { requestId: "r1" } },
      async () => "activity-ok",
    )));
    if (activity !== "activity-ok") throw new Error("activity import failed");
    if (typeof createFileActivityStore !== "function") throw new Error("file activity store import failed");
    if (typeof ActivitySerializationError !== "function") throw new Error("activity error import failed");
    let receiptScope;
    await run.scope(async (scope) => {
      receiptScope = scope;
    });
    const receipt = buildReceipt([], receiptScope.status());
    if (receipt.terminal.outcome !== "completed") throw new Error("replay import failed");
    if (analyzeReceipt(receipt).status !== "pass") throw new Error("analysis import failed");
    if (verifyReceipt(receipt).checks.length === 0) throw new Error("receipt verifier import failed");
    if (verifySourceProtocol({ modules: [] }).status !== "pass") throw new Error("source protocol verifier import failed");
    const ledger = createMemoryReceiptLedger();
    if ((await ledger.append(receipt)).receiptId !== receipt.receiptId) throw new Error("ledger import failed");
    const sqliteLedger = createSqliteReceiptLedger({ db: createSqliteConsumerDb() });
    if ((await sqliteLedger.append(receipt)).receiptId !== receipt.receiptId) throw new Error("sqlite ledger import failed");
    const postgresLedger = createPostgresReceiptLedger({ db: createPostgresConsumerDb() });
    if ((await postgresLedger.append(receipt)).receiptId !== receipt.receiptId) throw new Error("postgres ledger import failed");
    const faultReport = await runFaultScenario(cleanupHang({ cleanupTimeout: 1 }), { receiptId: "consumer-fault" });
    if (faultReport.status !== "pass") throw new Error("fault import failed");
    if (lazyAcquired !== 1) throw new Error("resources import failed");
    if (planTimePolicy({ type: "attempt", duration: 1 }).upperBoundMs !== 1) throw new Error("time import failed");
    if (typeof offload !== "function") throw new Error("worker import failed");

    function createSqliteConsumerDb() {
      const rows = new Map();
      return {
        async exec() {},
        async run(sql, params = []) {
          if (!sql.includes("INSERT OR IGNORE")) return;
          const [receiptId, checksum, createdAt, storedAt, receiptJson] = params;
          if (!rows.has(receiptId)) {
            rows.set(receiptId, {
              receipt_id: receiptId,
              checksum,
              created_at: createdAt,
              stored_at: storedAt,
              receipt_json: receiptJson,
            });
          }
        },
        async get(_sql, params = []) {
          return rows.get(params[0]);
        },
        async all() {
          return [...rows.values()];
        },
      };
    }

    function createPostgresConsumerDb() {
      const rows = new Map();
      return {
        async query(sql, params = []) {
          if (sql.includes("INSERT INTO")) {
            const [receiptId, checksum, createdAt, storedAt, receiptJson] = params;
            if (!rows.has(receiptId)) {
              const row = {
                receipt_id: receiptId,
                checksum,
                created_at: createdAt,
                stored_at: storedAt,
                receipt_json: JSON.parse(receiptJson),
              };
              rows.set(receiptId, row);
              return { rows: [row] };
            }
            return { rows: [] };
          }
          if (sql.includes("WHERE receipt_id")) return { rows: [rows.get(params[0])].filter(Boolean) };
          return { rows: [...rows.values()] };
        },
      };
    }
  `, "utf8");

  await execFileAsync(process.execPath, ["smoke.mjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "cjs-smoke.cjs"), `
    const { run, work } = require("@workit/core");
    const { cancellable, typedGroup } = require("@workit/core/contracts");

    (async () => {
      const values = await run.all([async () => "cjs", async () => "ok"]);
      const output = await work([1, 2, 3]).inParallel(2).do(async (item) => item + 1);
      const typed = await typedGroup(async (spawn) => await spawn(cancellable(async () => "contracts")));
      if (values.join(":") !== "cjs:ok") throw new Error("CommonJS root import failed");
      if (output.results.join(":") !== "2:3:4") throw new Error("CommonJS work import failed");
      if (typed !== "contracts") throw new Error("CommonJS contracts import failed");
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
      type Scope,
      type ScopeSnapshot,
      type TaskContext,
    } from "@workit/core";
    import {
      ActivitySerializationError,
      createFileActivityStore,
      createMemoryActivityStore,
      runActivity,
      type ActivityRecord,
      type ActivityStore,
    } from "@workit/core/activity";
    import {
      analyzeReceipt,
      verifyReceipt,
      verifySourceProtocol,
      type AnalysisReport,
      type ReceiptVerificationReport,
      type SourceProtocolAnalysisReport,
    } from "@workit/core/analysis";
    import { AgentCapabilityError, embedAll, runAgent, streamWithBackpressure } from "@workit/core/ai";
    import {
      cancellable,
      discardCancellation,
      getTaskContract,
      shielded,
      typedGroup,
      type CancellableTask,
      type ShieldedTask,
    } from "@workit/core/contracts";
    import { cleanupHang, runFaultScenario, type FaultReport } from "@workit/core/fault";
    import {
      createMemoryReceiptLedger,
      createPostgresReceiptLedger,
      createSqliteReceiptLedger,
      type PostgresReceiptLedgerClient,
      type ReceiptLedgerRecord,
      type SqliteReceiptLedgerClient,
    } from "@workit/core/ledger";
    import { buildReceipt, type WorkItReceipt } from "@workit/core/replay";
    import { bracketLazy, type LazyResource } from "@workit/core/resources";
    import { planTimePolicy, type TimePlan } from "@workit/core/time-policy";

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

    let receiptScope: Scope | undefined;
    await run.scope(async (scope) => {
      receiptScope = scope;
    });
    if (receiptScope === undefined) throw new Error("receipt scope missing");
    const receiptSnapshot: ScopeSnapshot = receiptScope.status();
    const receipt: WorkItReceipt = buildReceipt([], receiptSnapshot);
    if (receipt.version !== "workit.receipt.v1") throw new Error("receipt inference failed");

    const activityStore: ActivityStore = createMemoryActivityStore();
    const activityValue: string = await group(async (task) => await task(runActivity(
      activityStore,
      { activityId: "types-activity", input: { requestId: "r1" } },
      async () => "typed-activity",
    )));
    const activityRecord = await activityStore.get("types-activity") as ActivityRecord<string> | undefined;
    if (activityValue !== "typed-activity") throw new Error("activity inference failed");
    if (activityRecord?.status !== "completed" || activityRecord.result !== "typed-activity") {
      throw new Error("activity record inference failed");
    }
    const fileActivityStore: ActivityStore = createFileActivityStore({ dir: "." });
    void fileActivityStore;
    void ActivitySerializationError;

    const timePlan: TimePlan = planTimePolicy({ type: "attempt", duration: "1s" });
    if (timePlan.upperBoundMs !== 1_000) throw new Error("time-policy planner inference failed");

    const plainTask = async () => "plain";
    const typedTask: CancellableTask<string> = cancellable(async () => "typed-contract");
    const typedShieldedTask: ShieldedTask<string> = shielded(async () => "shielded-contract", { timeout: 100 });
    const discardedTask: ShieldedTask<string> = discardCancellation(typedTask, "types_flush", { timeout: 100 });
    const typedTaskValue: string = await typedGroup(async (spawn) => {
      const first = await spawn(typedTask);
      const second = await spawn.shielded(typedShieldedTask);
      const third = await spawn.shielded(discardedTask);
      return first + ":" + second + ":" + third;
    });
    if (!typedTaskValue.includes("typed-contract")) throw new Error("contracts inference failed");
    if (getTaskContract(discardedTask)?.kind !== "shielded") throw new Error("contracts metadata inference failed");
    // @ts-expect-error plain tasks must be declared cancellable before typed spawn.
    await typedGroup(async (spawn) => await spawn(plainTask));
    // @ts-expect-error shielded tasks must use the explicit shielded boundary.
    await typedGroup(async (spawn) => await spawn(typedShieldedTask));
    // @ts-expect-error cancellable tasks are not accepted by the shielded boundary.
    await typedGroup(async (spawn) => await spawn.shielded(typedTask));
    // @ts-expect-error discardCancellation requires declared cancellable work.
    discardCancellation(plainTask, "bad", { timeout: 100 });

    const analysisReport: AnalysisReport = analyzeReceipt(receipt);
    if (analysisReport.status !== "pass") throw new Error("analysis inference failed");
    const verificationReport: ReceiptVerificationReport = verifyReceipt(receipt);
    if (verificationReport.receiptId !== receipt.receiptId) throw new Error("receipt verifier inference failed");
    const sourceReport: SourceProtocolAnalysisReport = verifySourceProtocol({
      modules: [
        {
          moduleId: "consumer",
          functions: [
            {
              functionId: "handler",
              uses: [
                { operation: "resource.acquire" },
                { operation: "ctx.defer" },
              ],
            },
          ],
        },
      ],
    });
    if (sourceReport.status !== "pass") throw new Error("source protocol verifier inference failed");
    const ledger = createMemoryReceiptLedger();
    const ledgerRecord: ReceiptLedgerRecord = await ledger.append(receipt);
    if (ledgerRecord.receiptId !== receipt.receiptId) throw new Error("ledger inference failed");
    const sqliteRows = new Map<string, {
      receipt_id: string;
      checksum: string;
      created_at: number;
      stored_at: number;
      receipt_json: string;
    }>();
    const sqliteClient: SqliteReceiptLedgerClient = {
      async exec() {},
      async run(sql: string, params: readonly unknown[] = []) {
        if (!sql.includes("INSERT OR IGNORE")) return;
        const [receiptId, checksum, createdAt, storedAt, receiptJson] = params;
        if (
          typeof receiptId === "string"
          && typeof checksum === "string"
          && typeof createdAt === "number"
          && typeof storedAt === "number"
          && typeof receiptJson === "string"
          && !sqliteRows.has(receiptId)
        ) {
          sqliteRows.set(receiptId, {
            receipt_id: receiptId,
            checksum,
            created_at: createdAt,
            stored_at: storedAt,
            receipt_json: receiptJson,
          });
        }
      },
      async get<T = unknown>(_sql: string, params: readonly unknown[] = []) {
        return sqliteRows.get(String(params[0])) as T | undefined;
      },
      async all<T = unknown>() {
        return [...sqliteRows.values()] as T[];
      },
    };
    const sqliteRecord: ReceiptLedgerRecord = await createSqliteReceiptLedger({ db: sqliteClient }).append(receipt);
    if (sqliteRecord.receiptId !== receipt.receiptId) throw new Error("sqlite ledger inference failed");

    const postgresRows = new Map<string, {
      receipt_id: string;
      checksum: string;
      created_at: number;
      stored_at: number;
      receipt_json: WorkItReceipt;
    }>();
    const postgresClient: PostgresReceiptLedgerClient = {
      async query<T = unknown>(sql: string, params: readonly unknown[] = []) {
        if (sql.includes("INSERT INTO")) {
          const [receiptId, checksum, createdAt, storedAt, receiptJson] = params;
          if (
            typeof receiptId === "string"
            && typeof checksum === "string"
            && typeof createdAt === "number"
            && typeof storedAt === "number"
            && typeof receiptJson === "string"
            && !postgresRows.has(receiptId)
          ) {
            postgresRows.set(receiptId, {
              receipt_id: receiptId,
              checksum,
              created_at: createdAt,
              stored_at: storedAt,
              receipt_json: JSON.parse(receiptJson) as WorkItReceipt,
            });
            return { rows: [postgresRows.get(receiptId)] as T[] };
          }
          return { rows: [] as T[] };
        }
        if (sql.includes("WHERE receipt_id")) {
          return { rows: [postgresRows.get(String(params[0]))].filter(Boolean) as T[] };
        }
        return { rows: [...postgresRows.values()] as T[] };
      },
    };
    const postgresRecord: ReceiptLedgerRecord = await createPostgresReceiptLedger({ db: postgresClient }).append(receipt);
    if (postgresRecord.receiptId !== receipt.receiptId) throw new Error("postgres ledger inference failed");
    const faultReport: FaultReport = await runFaultScenario(cleanupHang({ cleanupTimeout: 1 }), {
      receiptId: "types-fault",
    });
    if (faultReport.status !== "pass") throw new Error("fault inference failed");

    await runAgent(async (agent) => {
      await agent.tool("read", undefined, async () => "ok", { capability: "repo:read" });
      // @ts-expect-error capability must be a string when supplied.
      await agent.tool("bad", undefined, async () => "bad", { capability: 1 });
    }, { authority: { allowedCapabilities: ["repo:read"] } });
    void AgentCapabilityError;

    const lazyTask = bracketLazy(
      async () => "resource",
      async (resource: LazyResource<string>) => await resource.get(),
      async () => undefined,
    );
    const lazyValue: string = await group(async (task) => await task(lazyTask));
    if (lazyValue !== "resource") throw new Error("resource helper inference failed");

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
    import { run } from "@workit/core";

    const result = await run.all([async () => "bun", async () => "ok"]);
    if (result.join(":") !== "bun:ok") throw new Error("Bun runtime fixture failed");
  `, "utf8");

  await execFileAsync(bunCli, ["bun-fixture.mjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "deno-fixture.mjs"), `
    import { run } from "@workit/core";

    const result = await run.all([async () => "deno", async () => "ok"]);
    if (result.join(":") !== "deno:ok") throw new Error("Deno runtime fixture failed");
  `, "utf8");

  await execFileAsync(denoCli, ["run", "--allow-read", "--allow-env", "--allow-sys", "deno-fixture.mjs"], {
    cwd: temp,
    timeout: 120_000,
  });

  await writeFile(join(temp, "aws-fixture.mjs"), `
    import { work } from "@workit/core";

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
    import { run } from "@workit/core";

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
    import { run } from "@workit/core";

    export async function POST(request) {
      const payload = await request.json();
      return Response.json({ query: payload.query, winner: await run.race([async () => "next"]) });
    }

    const response = await POST(new Request("https://example.test/api", { method: "POST", body: JSON.stringify({ query: "workit" }) }));
    const json = await response.json();
    if (json.query !== "workit" || json.winner !== "next") throw new Error("Next fixture failed");
  `, "utf8");

  await writeFile(join(temp, "express-fixture.mjs"), `
    import express from "express";
    import { request as httpRequest } from "node:http";
    import { run } from "@workit/core";

    let disconnectCancelled = false;
    let disconnectTaskStarted = false;
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
            disconnectTaskStarted = true;
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
        body: JSON.stringify({ items: ["express", "workit"] }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error("Express fixture status failed");
      if (body.output.join(":") !== "EXPRESS:WORKIT") throw new Error("Express fixture body failed");

      await new Promise((resolve) => {
        const req = httpRequest({
          hostname: "127.0.0.1",
          port: address.port,
          path: "/disconnect",
          method: "GET",
        });
        req.on("error", () => resolve());
        req.end();
        void (async () => {
          for (let attempt = 0; attempt < 100 && !disconnectTaskStarted; attempt++) {
            await new Promise((innerResolve) => setTimeout(innerResolve, 5));
          }
          req.destroy();
        })();
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
    import { work } from "@workit/core";

    const app = Fastify();
    app.post("/items", async (request) => {
      const output = await work(request.body.items).inParallel(2).do(async (item) => item.toUpperCase());
      return { output: output.results };
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/items",
        payload: { items: ["fastify", "workit"] },
      });
      const body = JSON.parse(response.body);
      if (response.statusCode !== 200) throw new Error("Fastify fixture status failed");
      if (body.output.join(":") !== "FASTIFY:WORKIT") throw new Error("Fastify fixture body failed");
    } finally {
      await app.close();
    }
  `, "utf8");

  await writeFile(join(temp, "trpc-fixture.mjs"), `
    import { initTRPC } from "@trpc/server";
    import { run } from "@workit/core";

    const t = initTRPC.create();
    const router = t.router({
      values: t.procedure.query(async () => {
        return await run.all([
          async () => "trpc",
          async () => "workit",
        ]);
      }),
    });

    const caller = router.createCaller({});
    const values = await caller.values();
    if (values.join(":") !== "trpc:workit") throw new Error("tRPC fixture failed");
  `, "utf8");

  await writeFile(join(temp, "vercel-ai-fixture.mjs"), `
    import { streamText } from "ai";
    import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
    import { run } from "@workit/core";

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
              { type: "text-delta", id: "0", delta: " workit" },
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
          // The important contract is that WorkIt aborts the signal supplied to streamText.
        }
      }, { name: "vercel-ai.stream" });
    });

    if (!modelSawAbort) throw new Error("Vercel AI SDK fixture did not receive WorkIt cancellation");
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
    import { group } from "@workit/core";
    import { offload } from "@workit/core/worker";
    globalThis.__workitBrowserSmoke = [typeof group, typeof offload];
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
    throw new Error("Browser bundle pulled in Node-only WorkIt modules");
  }
  if (!browserText.includes("UnsupportedRuntimeError")) {
    throw new Error("Browser bundle did not resolve to the explicit unsupported runtime split");
  }

  await writeFile(join(temp, "cloudflare-worker.mjs"), `
    import { group } from "@workit/core";

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
    "workit-compat-smoke",
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
    throw new Error("Cloudflare Worker dry-run pulled in Node-only WorkIt modules");
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
  if (executable.toLowerCase().endsWith(".js")) {
    return await execFileAsync(process.execPath, [executable, ...args], opts);
  }
  if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    const command = `call ${[executable, ...args].map(quoteCmdArg).join(" ")}`;
    return await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", command], opts);
  }
  return await execFileAsync(executable, args, opts);
}

async function runNpm(args, opts) {
  if (process.env.npm_execpath !== undefined) {
    return await execFileAsync(process.execPath, [process.env.npm_execpath, ...args], opts);
  }

  const bundledNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (await exists(bundledNpmCli)) {
    return await execFileAsync(process.execPath, [bundledNpmCli, ...args], opts);
  }

  const npmCli = await findExecutable(["npm.cmd", "npm"], []);
  if (npmCli === null) throw new Error("npm executable not found on PATH.");
  return await execCli(npmCli, args, opts);
}

function quoteCmdArg(value) {
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
