/**
 * Bounded async channel primitive.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Channels provide explicit backpressure for producer/consumer pipelines. They
 * are intentionally local in-memory coordination primitives; durable queues,
 * cross-process delivery, and replay belong in application infrastructure.
 */

export interface ChannelOpOptions {
  signal?: AbortSignal;
}

export type ChannelReceive<T> =
  | { done: false; value: T }
  | { done: true; reason?: unknown };

export interface Channel<T> extends AsyncIterable<T> {
  readonly capacity: number;
  readonly size: number;
  readonly closed: boolean;
  send(value: T, opts?: ChannelOpOptions): Promise<void>;
  receive(opts?: ChannelOpOptions): Promise<ChannelReceive<T>>;
  close(reason?: unknown): void;
}

export class ChannelClosedError extends Error {
  readonly reason?: unknown;

  constructor(reason?: unknown) {
    super("Channel is closed");
    this.name = "ChannelClosedError";
    this.reason = reason;
  }
}

interface Sender<T> {
  value: T;
  resolve: () => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
}

interface Receiver<T> {
  resolve: (item: ChannelReceive<T>) => void;
  reject: (err: unknown) => void;
  cleanup?: () => void;
}

const DEFAULT_CAPACITY = 1;

/** Creates a bounded FIFO channel with explicit producer backpressure. */
export function createChannel<T>(opts: { capacity?: number } = {}): Channel<T> {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError("channel capacity positive integer");
  }
  return new BoundedChannel<T>(capacity);
}

class BoundedChannel<T> implements Channel<T> {
  private readonly buffer: T[] = [];
  private readonly senders: Sender<T>[] = [];
  private readonly receivers: Receiver<T>[] = [];
  private closeReason: unknown;
  private isClosed = false;

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.buffer.length;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(value: T, opts: ChannelOpOptions = {}): Promise<void> {
    if (this.isClosed) return Promise.reject(new ChannelClosedError(this.closeReason));
    if (opts.signal?.aborted === true) return Promise.reject(abortReason(opts.signal));

    return new Promise((resolve, reject) => {
      const sender: Sender<T> = {
        value,
        resolve,
        reject,
      };
      sender.cleanup = installAbort(opts.signal, this.senders, sender, reject);
      this.senders.push(sender);
      this.pump();
    });
  }

  receive(opts: ChannelOpOptions = {}): Promise<ChannelReceive<T>> {
    if (opts.signal?.aborted === true) return Promise.reject(abortReason(opts.signal));

    return new Promise((resolve, reject) => {
      const receiver: Receiver<T> = {
        resolve,
        reject,
      };
      receiver.cleanup = installAbort(opts.signal, this.receivers, receiver, reject);
      this.receivers.push(receiver);
      this.pump();
    });
  }

  close(reason?: unknown): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeReason = reason;
    while (this.senders.length > 0) {
      const sender = this.senders.shift()!;
      sender.cleanup?.();
      sender.reject(new ChannelClosedError(reason));
    }
    this.pump();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = await this.receive();
      if (item.done) return;
      yield item.value;
    }
  }

  private pump(): void {
    while (this.receivers.length > 0 && this.buffer.length > 0) {
      const receiver = this.receivers.shift()!;
      receiver.cleanup?.();
      receiver.resolve({ done: false, value: this.buffer.shift()! });
    }

    while (!this.isClosed && this.senders.length > 0) {
      const sender = this.senders[0]!;
      if (this.receivers.length > 0) {
        this.senders.shift();
        const receiver = this.receivers.shift()!;
        sender.cleanup?.();
        receiver.cleanup?.();
        receiver.resolve({ done: false, value: sender.value });
        sender.resolve();
      } else if (this.buffer.length < this.capacity) {
        this.senders.shift();
        sender.cleanup?.();
        this.buffer.push(sender.value);
        sender.resolve();
      } else {
        break;
      }
    }

    if (this.isClosed && this.buffer.length === 0) {
      while (this.receivers.length > 0) {
        const receiver = this.receivers.shift()!;
        receiver.cleanup?.();
        receiver.resolve(
          this.closeReason === undefined ? { done: true } : { done: true, reason: this.closeReason }
        );
      }
    }
  }
}

function installAbort<T>(
  signal: AbortSignal | undefined,
  queue: T[],
  item: T,
  reject: (err: unknown) => void
): () => void {
  if (signal === undefined) return () => undefined;
  const onAbort = (): void => {
    const index = queue.indexOf(item);
    /* v8 ignore next -- abort listeners are removed immediately after dequeue. */
    if (index >= 0) queue.splice(index, 1);
    reject(abortReason(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Channel operation aborted");
}
