/**
 * Bounded channel subpath tests.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import { createChannel, ChannelClosedError } from "../../dist/channel/index.js";

test("channel preserves FIFO delivery and drains buffered values after close", async () => {
  const channel = createChannel({ capacity: 2 });

  await channel.send("a");
  await channel.send("b");
  channel.close("done");

  assert.deepEqual(await channel.receive(), { done: false, value: "a" });
  assert.deepEqual(await channel.receive(), { done: false, value: "b" });
  assert.deepEqual(await channel.receive(), { done: true, reason: "done" });
});

test("channel send waits for capacity and then resumes in order", async () => {
  const channel = createChannel({ capacity: 1 });
  await channel.send(1);

  let sent = false;
  const blocked = channel.send(2).then(() => {
    sent = true;
  });

  await Promise.resolve();
  assert.equal(sent, false);
  assert.deepEqual(await channel.receive(), { done: false, value: 1 });
  await blocked;
  assert.equal(sent, true);
  assert.deepEqual(await channel.receive(), { done: false, value: 2 });
});

test("channel receive waits until a sender provides a value", async () => {
  const channel = createChannel();
  const waiting = channel.receive();

  await channel.send("late");

  assert.deepEqual(await waiting, { done: false, value: "late" });
});

test("channel rejects pending operations when their signal aborts", async () => {
  const channel = createChannel({ capacity: 1 });
  await channel.send("filled");

  const sendAbort = new AbortController();
  const blockedSend = channel.send("blocked", { signal: sendAbort.signal });
  sendAbort.abort(new Error("send-abort"));
  await assert.rejects(blockedSend, /send-abort/);

  const receiveAbort = new AbortController();
  const blockedReceive = createChannel().receive({ signal: receiveAbort.signal });
  receiveAbort.abort(new Error("receive-abort"));
  await assert.rejects(blockedReceive, /receive-abort/);
});

test("channel rejects sends after close and supports async iteration", async () => {
  const channel = createChannel({ capacity: 2 });
  await channel.send(1);
  await channel.send(2);
  channel.close("done");

  await assert.rejects(
    channel.send(3),
    (err) => err instanceof ChannelClosedError && err.reason === "done"
  );

  const values = [];
  for await (const value of channel) values.push(value);
  assert.deepEqual(values, [1, 2]);
});
