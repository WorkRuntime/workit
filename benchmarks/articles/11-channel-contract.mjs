/**
 * Bench 11 -- createChannel contract.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Five scenarios prove the channel's runtime contract:
 *
 *   A. capacity_backpressure   -- send blocks when the channel is full;
 *                                receive unblocks the next pending send.
 *   B. close_drains            -- close() lets buffered values drain; then
 *                                async iteration ends with done=true.
 *   C. close_rejects_pending   -- pending sends after close() reject with
 *                                ChannelClosedError carrying the reason.
 *   D. signal_cancels_receive  -- a receive that is awaiting on an empty
 *                                channel rejects when its signal aborts.
 *   E. capacity_validation     -- createChannel rejects 0/-1/0.5/NaN at
 *                                construction.
 */

import assert from "node:assert/strict";
import { ChannelClosedError, createChannel } from "../../dist/channel/index.js";
import { makeClock, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "11-channel-contract" };

// --- A -- capacity_backpressure ------------------------------------------
{
  const clock = makeClock();
  const ch = createChannel({ capacity: 2 });
  await ch.send("a");
  await ch.send("b");        // channel is now full

  let thirdSendStartedAt = clock.t();
  let thirdSendCompletedAt = -1;
  let thirdSettledBeforeReceive = false;
  let thirdSettled = false;
  const third = ch.send("c").then(() => {
    thirdSettled = true;
    thirdSendCompletedAt = clock.t();
  });

  // One microtask turn is enough to catch an incorrectly unblocked send
  // without making the bench depend on wall-clock timer jitter.
  await Promise.resolve();
  thirdSettledBeforeReceive = thirdSettled;

  // Receive one -- third send must complete shortly after.
  const r1 = await ch.receive();
  await third;
  const completedAfterReceiveBy = thirdSendCompletedAt - thirdSendStartedAt;

  result.A_capacity_backpressure = {
    capacity: 2,
    sizeAfterTwoSends: 2,
    thirdSendStartedAt,
    thirdSendCompletedAt,
    thirdSettledBeforeReceive,
    firstReceived: r1,
    thirdSendUnblockedWithinMs: completedAfterReceiveBy,
  };

  assert.equal(thirdSettledBeforeReceive, false, "third send must remain pending while channel is full");
  assert.equal(thirdSettled, true, "third send must complete after a receive frees a slot");
  assert.deepEqual(r1, { done: false, value: "a" });
}

// --- B -- close_drains ---------------------------------------------------
{
  const ch = createChannel({ capacity: 8 });
  await ch.send(1);
  await ch.send(2);
  await ch.send(3);
  ch.close();

  const collected = [];
  for await (const v of ch) collected.push(v);
  result.B_close_drains = {
    collected,
    iterationEndedCleanly: true,
  };
  assert.deepEqual(collected, [1, 2, 3], "buffered values must drain after close()");
}

// --- C -- close_rejects_pending ------------------------------------------
{
  const ch = createChannel({ capacity: 1 });
  await ch.send("x");        // fills the buffer
  let rejectedClass = null;
  let rejectionReason = null;

  const pending = ch.send("y").catch((err) => {
    rejectedClass = err?.constructor?.name ?? "Unknown";
    rejectionReason = err instanceof ChannelClosedError ? err.reason : null;
  });
  ch.close({ tag: "shutdown" });
  await pending;

  result.C_close_rejects_pending = { rejectedClass, rejectionReason };
  assert.equal(rejectedClass, "ChannelClosedError");
  assert.deepEqual(rejectionReason, { tag: "shutdown" });
}

// --- D -- signal_cancels_receive -----------------------------------------
{
  const ch = createChannel({ capacity: 1 });
  const ctrl = new AbortController();

  let rejectedClass = null;
  const pending = ch.receive({ signal: ctrl.signal }).catch((err) => {
    rejectedClass = err?.constructor?.name ?? "Unknown";
  });
  setTimeout(() => ctrl.abort(new Error("user-aborted")), 20);
  await pending;

  result.D_signal_cancels_receive = { rejectedClass };
  assert.ok(rejectedClass !== null, "pending receive must reject when signal aborts");
}

// --- E -- capacity_validation --------------------------------------------
{
  const rejected = [];
  for (const bad of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    try { createChannel({ capacity: bad }); rejected.push({ bad, accepted: true }); }
    catch (err) { rejected.push({ bad, error: err?.constructor?.name ?? "Error" }); }
  }
  result.E_capacity_validation = { rejected };
  for (const r of rejected) assert.ok(r.error !== undefined, `capacity ${r.bad} must be rejected`);
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
