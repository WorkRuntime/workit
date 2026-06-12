/**
 * Explicit durable activity boundaries for WorkIt tasks.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Activity boundaries persist idempotency and terminal evidence for named task
 * segments. They do not persist arbitrary JavaScript stacks, scheduler state,
 * closures, or external side effects.
 */

import { createHash } from "node:crypto";

import {
  CancellationError,
  type CancelReason,
  type TaskFn,
} from "../types/index.js";

type MaybePromise<T> = T | Promise<T>;

/** Schema version emitted by the activity boundary subpath. */
export type WorkItActivityVersion = "workit.activity.v1";

/** Terminal and non-terminal activity states. */
export type ActivityStatus = "started" | "completed" | "failed" | "cancelled";

/** Safe error evidence persisted for failed activity boundaries. */
export interface ActivityErrorEvidence {
  readonly name: string;
  readonly message: string;
}

/** Base activity record shared by all statuses. */
export interface ActivityRecordBase {
  readonly version: WorkItActivityVersion;
  readonly activityId: string;
  readonly inputHash: string;
  readonly status: ActivityStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly name?: string;
  readonly activityVersion?: string;
}

/** Non-terminal activity record created when a boundary is claimed. */
export interface ActivityStartedRecord extends ActivityRecordBase {
  readonly status: "started";
}

/** Completed activity record with a cached, caller-owned result payload. */
export interface ActivityCompletedRecord<T = unknown> extends ActivityRecordBase {
  readonly status: "completed";
  readonly completedAt: number;
  readonly result: T;
}

/** Failed activity record with safe error evidence. */
export interface ActivityFailedRecord extends ActivityRecordBase {
  readonly status: "failed";
  readonly failedAt: number;
  readonly error: ActivityErrorEvidence;
}

/** Cancelled activity record with WorkIt's typed cancellation reason. */
export interface ActivityCancelledRecord extends ActivityRecordBase {
  readonly status: "cancelled";
  readonly cancelledAt: number;
  readonly cancelReason: CancelReason;
}

/** Persisted activity boundary record. */
export type ActivityRecord<T = unknown> =
  | ActivityStartedRecord
  | ActivityCompletedRecord<T>
  | ActivityFailedRecord
  | ActivityCancelledRecord;

/** Result returned when a store attempts to claim an activity id. */
export interface ActivityStartResult {
  readonly status: "started" | "existing";
  readonly record: ActivityRecord;
}

/** Caller-owned activity store contract. */
export interface ActivityStore {
  start(record: ActivityStartedRecord): MaybePromise<ActivityStartResult>;
  finish(record: ActivityRecord): MaybePromise<ActivityRecord>;
  get(activityId: string): MaybePromise<ActivityRecord | undefined>;
}

/** Options for the in-memory activity store. */
export interface MemoryActivityStoreOptions {
  readonly maxRecords?: number;
}

/** Options for file-backed activity stores. */
export interface FileActivityStoreOptions {
  /** Directory that stores one JSON activity record per activity id. */
  readonly dir: string;
}

/** Explicit activity boundary contract. */
export interface ActivitySpec<TInput = unknown> {
  readonly activityId: string;
  readonly input: TInput;
  readonly name?: string;
  readonly version?: string;
}

/** Options for activity execution. */
export interface ActivityRunOptions {
  readonly clock?: () => number;
}

/** Error thrown when an activity id is reused with different input. */
export class ActivityConflictError extends Error {
  readonly activityId: string;

  constructor(activityId: string) {
    super(`Activity conflict for id "${activityId}"`);
    this.name = "ActivityConflictError";
    this.activityId = activityId;
  }
}

/** Error thrown when a stored non-completed activity cannot be executed again. */
export class ActivityNotRunnableError extends Error {
  readonly activityId: string;
  readonly status: ActivityStatus;

  constructor(activityId: string, status: ActivityStatus) {
    super(`Activity "${activityId}" is already recorded as ${status}`);
    this.name = "ActivityNotRunnableError";
    this.activityId = activityId;
    this.status = status;
  }
}

/** Error thrown when an activity payload cannot be converted to stable JSON. */
export class ActivitySerializationError extends Error {
  readonly activityId: string;

  constructor(activityId: string, message: string) {
    super(`Activity "${activityId}" payload is not serializable: ${message}`);
    this.name = "ActivitySerializationError";
    this.activityId = activityId;
  }
}

/** Creates a bounded in-memory activity store for tests and short-lived processes. */
export function createMemoryActivityStore(opts: MemoryActivityStoreOptions = {}): ActivityStore {
  const maxRecords = opts.maxRecords ?? 10_000;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) {
    throw new RangeError("maxRecords must be a positive integer");
  }

  const records = new Map<string, ActivityRecord>();
  return {
    async start(record) {
      const existing = records.get(record.activityId);
      if (existing !== undefined) return { status: "existing", record: cloneRecord(existing) };
      if (records.size >= maxRecords) {
        const oldest = records.keys().next().value;
        /* v8 ignore else -- size >= maxRecords guarantees one key exists. */
        if (oldest !== undefined) records.delete(oldest);
      }
      records.set(record.activityId, cloneRecord(record));
      return { status: "started", record: cloneRecord(record) };
    },
    async finish(record) {
      const existing = records.get(record.activityId);
      if (existing === undefined || existing.inputHash !== record.inputHash) {
        throw new ActivityConflictError(record.activityId);
      }
      if (existing.status !== "started") {
        throw new ActivityNotRunnableError(record.activityId, existing.status);
      }
      records.set(record.activityId, cloneRecord(record));
      return cloneRecord(record);
    },
    async get(activityId) {
      const record = records.get(activityId);
      return record === undefined ? undefined : cloneRecord(record);
    },
  };
}

/** Creates a file-backed activity store for explicit restart/replay boundaries. */
export function createFileActivityStore(opts: FileActivityStoreOptions): ActivityStore {
  assertBoundedString("dir", opts.dir, 4_096);

  return {
    async start(record) {
      const file = activityPath(opts.dir, record.activityId);
      const stored = await writeNewActivityRecord(opts.dir, file, record);
      return {
        status: stored.created ? "started" : "existing",
        record: cloneRecord(stored.record),
      };
    },
    async finish(record) {
      const file = activityPath(opts.dir, record.activityId);
      const existing = await readActivityRecord(file);
      if (existing === undefined || existing.inputHash !== record.inputHash) {
        throw new ActivityConflictError(record.activityId);
      }
      if (existing.status !== "started") {
        throw new ActivityNotRunnableError(record.activityId, existing.status);
      }
      await writeActivityRecord(opts.dir, file, record);
      return cloneRecord(record);
    },
    async get(activityId) {
      return await readActivityRecord(activityPath(opts.dir, activityId));
    },
  };
}

/** Wraps a task body in an explicit persisted activity boundary. */
export function runActivity<TInput, TOutput>(
  store: ActivityStore,
  spec: ActivitySpec<TInput>,
  task: TaskFn<TOutput>,
  opts: ActivityRunOptions = {},
): TaskFn<TOutput> {
  const normalized = normalizeSpec(spec);
  const inputHash = hashInput(normalized.activityId, normalized.input);
  const clock = opts.clock ?? Date.now;

  return async (ctx) => {
    const startedAt = clock();
    const started = makeStartedRecord(normalized, inputHash, startedAt);
    const claim = await store.start(started);
    if (claim.record.inputHash !== inputHash) throw new ActivityConflictError(normalized.activityId);
    if (claim.status === "existing") return replayExisting<TOutput>(claim.record);

    try {
      const result = normalizeActivityPayload<TOutput>(normalized.activityId, await task(ctx));
      const completedAt = clock();
      await store.finish({
        ...started,
        status: "completed",
        result,
        completedAt,
        updatedAt: completedAt,
      });
      return result;
    } catch (error) {
      if (error instanceof CancellationError) {
        const cancelledAt = clock();
        await store.finish({
          ...started,
          status: "cancelled",
          cancelReason: error.reason,
          cancelledAt,
          updatedAt: cancelledAt,
        });
      } else {
        const failedAt = clock();
        await store.finish({
          ...started,
          status: "failed",
          error: normalizeError(error),
          failedAt,
          updatedAt: failedAt,
        });
      }
      throw error;
    }
  };
}

function replayExisting<TOutput>(record: ActivityRecord): TOutput {
  if (record.status === "completed") return record.result as TOutput;
  throw new ActivityNotRunnableError(record.activityId, record.status);
}

function makeStartedRecord<TInput>(
  spec: Required<ActivitySpec<TInput>>,
  inputHash: string,
  startedAt: number,
): ActivityStartedRecord {
  return {
    version: "workit.activity.v1",
    activityId: spec.activityId,
    name: spec.name,
    activityVersion: spec.version,
    inputHash,
    status: "started",
    startedAt,
    updatedAt: startedAt,
  };
}

function normalizeSpec<TInput>(spec: ActivitySpec<TInput>): Required<ActivitySpec<TInput>> {
  assertBoundedString("activityId", spec.activityId, 512);
  return {
    activityId: spec.activityId,
    input: spec.input,
    name: spec.name ?? spec.activityId,
    version: spec.version ?? "v1",
  };
}

function assertBoundedString(field: string, value: string, maxLength: number): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new RangeError(`${field} must be a non-empty string up to ${maxLength} characters`);
  }
}

function hashInput(activityId: string, value: unknown): string {
  const text = stableStringify(activityId, value);
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function normalizeError(error: unknown): ActivityErrorEvidence {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: typeof error, message: String(error) };
}

function normalizeActivityPayload<T>(activityId: string, value: T): T {
  return JSON.parse(stableStringify(activityId, value)) as T;
}

function cloneRecord<T>(record: ActivityRecord<T>): ActivityRecord<T> {
  return JSON.parse(JSON.stringify(record)) as ActivityRecord<T>;
}

function activityPath(dir: string, activityId: string): string {
  assertBoundedString("activityId", activityId, 512);
  return `${dir}/${Buffer.from(activityId, "utf8").toString("base64url")}.json`;
}

async function writeNewActivityRecord(
  dir: string,
  file: string,
  record: ActivityStartedRecord,
): Promise<{ created: boolean; record: ActivityRecord }> {
  const { mkdir, readFile, writeFile } = await loadFileStoreDeps();
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { created: true, record: cloneRecord(record) };
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      return {
        created: false,
        record: JSON.parse(await readFile(file, "utf8")) as ActivityRecord,
      };
    }
    throw error;
  }
}

async function writeActivityRecord(dir: string, file: string, record: ActivityRecord): Promise<void> {
  const { mkdir, rename, writeFile } = await loadFileStoreDeps();
  await mkdir(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function readActivityRecord(file: string): Promise<ActivityRecord | undefined> {
  const { readFile } = await loadFileStoreDeps();
  try {
    return JSON.parse(await readFile(file, "utf8")) as ActivityRecord;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function loadFileStoreDeps(): Promise<{
  mkdir: typeof import("node:fs/promises").mkdir;
  readFile: typeof import("node:fs/promises").readFile;
  rename: typeof import("node:fs/promises").rename;
  writeFile: typeof import("node:fs/promises").writeFile;
}> {
  const fs = await import("node:fs/promises");
  return {
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    rename: fs.rename,
    writeFile: fs.writeFile,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === code;
}

function stableStringify(activityId: string, value: unknown): string {
  const text = JSON.stringify(sortValue(activityId, value, new WeakSet<object>()));
  /* v8 ignore next -- sortValue rejects or converts every value that would stringify to undefined. */
  if (text === undefined) throw new ActivitySerializationError(activityId, "input did not produce JSON");
  return text;
}

function sortValue(activityId: string, value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) throw new ActivitySerializationError(activityId, "undefined is not valid JSON");
  if (typeof value === "bigint") throw new ActivitySerializationError(activityId, "bigint is not valid JSON");
  if (typeof value === "function") throw new ActivitySerializationError(activityId, "functions are not valid JSON");
  if (typeof value === "symbol") throw new ActivitySerializationError(activityId, "symbols are not valid JSON");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ActivitySerializationError(activityId, "non-finite numbers are not valid JSON");
  }
  if (value instanceof Date) return value.toJSON();
  if (Array.isArray(value)) return value.map((item) => sortValue(activityId, item, seen));
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new ActivitySerializationError(activityId, "cyclic objects are not valid JSON");
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortValue(activityId, (value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return output;
}
