import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool, toolSync } from "../src/tool.js";

describe("tool() with JSON Schema", () => {
  it("preserves the JSON schema as-is", async () => {
    const t = await tool({
      name: "echo",
      description: "Echo back the input",
      inputSchema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      execute: async (input: { msg: string }) => input,
    });
    expect(t.parameters).toEqual({
      type: "object",
      properties: { msg: { type: "string" } },
      required: ["msg"],
    });
  });

  it("parses JSON args without validation when no Zod", async () => {
    const t = await tool({
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object" },
      execute: async (input: unknown) => input,
    });
    expect(t.parseInput('{"hello":"world"}')).toEqual({ hello: "world" });
  });

  it("throws a clear error on non-JSON args", async () => {
    const t = await tool({
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object" },
      execute: async (input: unknown) => input,
    });
    expect(() => t.parseInput("not json {")).toThrow(/non-JSON arguments/);
  });
});

describe("tool() with Zod schema", () => {
  it("validates and parses input with Zod", async () => {
    const t = await tool({
      name: "search",
      description: "Search",
      inputSchema: z.object({ query: z.string(), limit: z.number().default(10) }),
      execute: async ({ query, limit }) => ({ query, limit }),
    });
    const parsed = t.parseInput('{"query":"hello"}') as { query: string; limit: number };
    expect(parsed.query).toBe("hello");
    expect(parsed.limit).toBe(10); // default applied
  });

  it("Zod throws on missing required field", async () => {
    const t = await tool({
      name: "search",
      description: "Search",
      inputSchema: z.object({ query: z.string() }),
      execute: async () => null,
    });
    expect(() => t.parseInput("{}")).toThrow();
  });
});

describe("toolSync", () => {
  it("returns a tool synchronously without Zod overhead", () => {
    const t = toolSync({
      name: "ping",
      description: "Ping",
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
      execute: async (input: { x: number }) => input.x * 2,
    });
    expect(t.name).toBe("ping");
    expect(t.parseInput('{"x":3}')).toEqual({ x: 3 });
  });
});

describe("tool approval hook", () => {
  it("invokes onToolCalled and respects rejection", async () => {
    let approveArgs: unknown = null;
    const t = await tool({
      name: "risky",
      description: "Risky tool",
      inputSchema: { type: "object" },
      execute: async () => "executed",
      onToolCalled: (input) => {
        approveArgs = input;
        return { approved: false, reason: "user denied" };
      },
    });
    expect(t.onToolCalled).toBeDefined();
    const result = await t.onToolCalled!({ test: 1 }, {
      step: 0,
      toolCallId: "x",
      traceId: "t",
      signal: new AbortController().signal,
    });
    expect(approveArgs).toEqual({ test: 1 });
    expect(result.approved).toBe(false);
  });
});
