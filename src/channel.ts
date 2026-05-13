/**
 * A push/pull async-iterable channel.
 *
 * The streaming agent loop pushes events as it produces them; consumers
 * (callModel result getters) iterate them with a regular `for await`. If
 * nobody is iterating yet, events buffer in memory until they're read.
 *
 * Multiple consumers can iterate the same channel — each gets every event
 * (broadcast semantics). For single-consumer use, just don't subscribe twice.
 */

export class Channel<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private error: unknown = null;
  private subscribers: Channel<T>[] = [];

  /** Push an event. If consumers are waiting, deliver immediately; else buffer. */
  push(item: T): void {
    if (this.closed) return;
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
    // Broadcast to subs (each sub gets its own copy of the event).
    for (const sub of this.subscribers) sub.push(item);
  }

  /** Close the channel. After close, consumers see iteration end. */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    if (error !== undefined) this.error = error;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      // Use done: true; if there's an error, we throw on next() call instead.
      w({ value: undefined as unknown as T, done: true });
    }
    for (const sub of this.subscribers) sub.close(error);
  }

  /** Create a downstream copy that receives every future event. */
  subscribe(): Channel<T> {
    const sub = new Channel<T>();
    this.subscribers.push(sub);
    // Replay buffered events so late subscribers don't miss anything.
    for (const item of this.buffer) sub.push(item);
    if (this.closed) sub.close(this.error ?? undefined);
    return sub;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    const self = this;
    return {
      next(): Promise<IteratorResult<T>> {
        if (self.error !== null && self.buffer.length === 0) {
          return Promise.reject(self.error);
        }
        if (self.buffer.length > 0) {
          return Promise.resolve({ value: self.buffer.shift()!, done: false });
        }
        if (self.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          self.waiters.push(resolve);
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}
