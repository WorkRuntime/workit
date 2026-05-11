/**
 * Property tests for core WorkIt runtime invariants.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * These tests use bounded, seeded fast-check properties against the built
 * public package. They are intended to find schedule-sensitive regressions
 * without turning normal CI into an unbounded fuzz run.
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  CancellationError,
  TimeoutError,
  run,
  work,
} from "../../dist/index.js";

const PROPERTY_RUNS = 35;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

const delayVector = (maxLength = 32) =>
  fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength })
    .chain((delays) => fc.record({
      delays: fc.constant(delays),
      concurrency: fc.integer({ min: 1, max: Math.min(8, delays.length) }),
    }));

test("property: run.pool preserves order and never exceeds the concurrency cap", async () => {
  await fc.assert(
    fc.asyncProperty(delayVector(), async ({ delays, concurrency }) => {
      let active = 0;
      let maxActive = 0;

      const tasks = delays.map((delay, index) => async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await sleep(delay);
          return index;
        } finally {
          active--;
        }
      });

      const output = await run.pool(concurrency, tasks);

      assert.deepEqual(output, delays.map((_delay, index) => index));
      assert.ok(maxActive <= concurrency, `maxActive=${maxActive}, concurrency=${concurrency}`);
      assert.equal(active, 0);
    }),
    { numRuns: PROPERTY_RUNS, seed: 0x5EED01 }
  );
});

test("property: work().inParallel preserves input order and respects the concurrency cap", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          value: fc.integer({ min: -1_000, max: 1_000 }),
          delay: fc.integer({ min: 0, max: 3 }),
        }),
        { minLength: 1, maxLength: 32 }
      ).chain((items) => fc.record({
        items: fc.constant(items),
        concurrency: fc.integer({ min: 1, max: Math.min(8, items.length) }),
      })),
      async ({ items, concurrency }) => {
        let active = 0;
        let maxActive = 0;

        const output = await work(items)
          .inParallel(concurrency)
          .do(async (item) => {
            active++;
            maxActive = Math.max(maxActive, active);
            try {
              await sleep(item.delay);
              return item.value * 2;
            } finally {
              active--;
            }
          });

        assert.equal(output.mode, "fail");
        assert.deepEqual(output.results, items.map((item) => item.value * 2));
        assert.ok(maxActive <= concurrency, `maxActive=${maxActive}, concurrency=${concurrency}`);
        assert.equal(active, 0);
      }
    ),
    { numRuns: PROPERTY_RUNS, seed: 0x5EED02 }
  );
});

test("property: run.race cancels every cooperative loser with a typed race_lost reason", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        loserCount: fc.integer({ min: 1, max: 8 }),
        winnerOffset: fc.integer({ min: 0, max: 8 }),
      }),
      async ({ loserCount, winnerOffset }) => {
        const taskCount = loserCount + 1;
        const winnerIndex = winnerOffset % taskCount;
        const cancelled = [];

        const tasks = Array.from({ length: taskCount }, (_, index) => {
          if (index === winnerIndex) {
            return async () => {
              await Promise.resolve();
              return "winner";
            };
          }

          return async (ctx) => {
            try {
              await sleep(1_000, ctx.signal);
              return "loser";
            } catch (err) {
              if (err instanceof CancellationError && err.reason.kind === "race_lost") {
                cancelled.push({ index, winnerId: err.reason.winnerId });
              }
              throw err;
            }
          };
        });

        assert.equal(await run.race(tasks), "winner");
        assert.equal(cancelled.length, loserCount);
        assert.ok(cancelled.every((entry) => typeof entry.winnerId === "string" && entry.winnerId.length > 0));
      }
    ),
    { numRuns: PROPERTY_RUNS, seed: 0x5EED03 }
  );
});

test("property: run.retry stops immediately when a cancellation error is thrown", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (cancelAtAttempt) => {
      let attempts = 0;
      const tag = `property-cancel-${cancelAtAttempt}`;

      await assert.rejects(
        run.group(async (task) => task(run.retry(async () => {
          attempts++;
          if (attempts === cancelAtAttempt) {
            throw new CancellationError({ kind: "manual", tag });
          }
          throw new Error(`transient-${attempts}`);
        }, {
          times: cancelAtAttempt + 3,
          backoff: "fixed",
          initialDelay: 1,
          maxDelay: 1,
          jitter: false,
        }))),
        (err) => err instanceof CancellationError
          && err.reason.kind === "manual"
          && err.reason.tag === tag
      );

      assert.equal(attempts, cancelAtAttempt);
    }),
    { numRuns: PROPERTY_RUNS, seed: 0x5EED04 }
  );
});

test("property: timeout preserves a typed timeout cancellation reason", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (timeoutMs) => {
      await assert.rejects(
        run.group(async (task) => task(run.timeout(async (ctx) => {
          await sleep(timeoutMs + 50, ctx.signal);
          return "late";
        }, timeoutMs))),
        (err) => err instanceof TimeoutError
          && err.reason.kind === "timeout"
          && err.reason.timeoutMs === timeoutMs
      );
    }),
    { numRuns: PROPERTY_RUNS, seed: 0x5EED05 }
  );
});

test("property: the first cancellation reason remains authoritative", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 8 }),
      async (rawTags) => {
        const tags = rawTags.map((tag) => `tag-${tag}`);
        const observed = [];

        await assert.rejects(
          run.group(async (task) => {
            await task(async (ctx) => {
              ctx.scope.onCancel((reason) => observed.push(reason));
              for (const tag of tags) {
                ctx.scope.cancel({ kind: "manual", tag });
              }
              await sleep(50, ctx.signal);
            });
          }),
          CancellationError
        );

        assert.deepEqual(observed, [{ kind: "manual", tag: tags[0] }]);
      }
    ),
    { numRuns: PROPERTY_RUNS, seed: 0x5EED06 }
  );
});
