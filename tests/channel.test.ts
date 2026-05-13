import { describe, it, expect } from "vitest";
import { Channel } from "../src/channel.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("Channel", () => {
  it("buffers events pushed before iteration starts", async () => {
    const ch = new Channel<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();
    const out = await collect(ch);
    expect(out).toEqual([1, 2, 3]);
  });

  it("delivers events that arrive after iteration starts", async () => {
    const ch = new Channel<string>();
    const consumerPromise = collect(ch);
    setTimeout(() => ch.push("a"), 5);
    setTimeout(() => ch.push("b"), 10);
    setTimeout(() => ch.close(), 15);
    expect(await consumerPromise).toEqual(["a", "b"]);
  });

  it("ignores pushes after close", async () => {
    const ch = new Channel<number>();
    ch.push(1);
    ch.close();
    ch.push(2);
    expect(await collect(ch)).toEqual([1]);
  });

  it("propagates error to the consumer", async () => {
    const ch = new Channel<number>();
    const consumer = (async () => {
      const out: number[] = [];
      try {
        for await (const x of ch) out.push(x);
      } catch (e) {
        return { out, error: e };
      }
      return { out, error: null };
    })();
    ch.push(1);
    ch.close(new Error("boom"));
    const result = await consumer;
    expect(result.out).toEqual([1]);
    expect((result.error as Error).message).toBe("boom");
  });

  it("subscribe() gives a downstream channel with replay of buffered events", async () => {
    const ch = new Channel<number>();
    ch.push(1);
    ch.push(2);
    const sub = ch.subscribe();
    ch.push(3);
    ch.close();
    const main = await collect(ch);
    const subOut = await collect(sub);
    expect(main).toEqual([1, 2, 3]);
    expect(subOut).toEqual([1, 2, 3]); // sub got the buffered 1+2 plus live 3
  });

  it("multiple subscribers each receive every event", async () => {
    const ch = new Channel<string>();
    const a = ch.subscribe();
    const b = ch.subscribe();
    ch.push("x");
    ch.push("y");
    ch.close();
    expect(await collect(a)).toEqual(["x", "y"]);
    expect(await collect(b)).toEqual(["x", "y"]);
  });
});
