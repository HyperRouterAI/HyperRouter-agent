import { describe, it, expect } from "vitest";
import { parseSseStream, chunkText, chunkFinishReason } from "../src/sse.js";

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("SSE parser", () => {
  it("parses single-event stream", async () => {
    const s = streamFromString(
      'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
    );
    const chunks = await collect(parseSseStream(s));
    expect(chunks).toHaveLength(1);
    expect(chunkText(chunks[0]!)).toBe("hi");
  });

  it("yields text deltas in order across multiple events", async () => {
    const s = streamFromString(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" wo"}}]}\n\n' +
        'data: [DONE]\n\n',
    );
    const chunks = await collect(parseSseStream(s));
    expect(chunks.map(chunkText).join("")).toBe("Hello wo");
  });

  it("handles event split across network packets", async () => {
    // The event boundary "\n\n" is split between packets.
    const full = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n';
    const mid = 30; // arbitrary cut, falls inside the JSON payload
    const s = streamFromChunks([full.slice(0, mid), full.slice(mid)]);
    const chunks = await collect(parseSseStream(s));
    expect(chunks).toHaveLength(1);
    expect(chunkText(chunks[0]!)).toBe("partial");
  });

  it("ignores comments and blank lines", async () => {
    const s = streamFromString(
      ': this is a keepalive comment\n' +
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        '\n' +
        'data: [DONE]\n\n',
    );
    const chunks = await collect(parseSseStream(s));
    expect(chunks).toHaveLength(1);
    expect(chunkText(chunks[0]!)).toBe("ok");
  });

  it("captures finish_reason on last chunk", async () => {
    const s = streamFromString(
      'data: {"choices":[{"delta":{"content":"end"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    const chunks = await collect(parseSseStream(s));
    expect(chunkFinishReason(chunks[0]!)).toBe("stop");
  });

  it("skips malformed JSON chunks without crashing", async () => {
    const s = streamFromString(
      'data: {malformed\n\n' +
        'data: {"choices":[{"delta":{"content":"good"}}]}\n\n' +
        'data: [DONE]\n\n',
    );
    const chunks = await collect(parseSseStream(s));
    expect(chunks).toHaveLength(1);
    expect(chunkText(chunks[0]!)).toBe("good");
  });

  it("terminates on [DONE] even if more bytes follow", async () => {
    const s = streamFromString(
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n' +
        'data: [DONE]\n\n' +
        'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    );
    const chunks = await collect(parseSseStream(s));
    expect(chunks).toHaveLength(1);
    expect(chunkText(chunks[0]!)).toBe("a");
  });
});
