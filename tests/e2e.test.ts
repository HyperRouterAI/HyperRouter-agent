/**
 * End-to-end tests against a Node http mock server.
 *
 * Catches the class of bug the unit tests miss: SDK reads response headers
 * with one name (`x-hr-cost-usd`) but backend emits a different one
 * (`X-HR-Cost`). The unit tests stub at the channel level and never see this.
 *
 * Each test spins up a tiny mock that mimics Hyper Router's wire format —
 * SSE chat completions with HR-specific response headers, plus a
 * /credits/balance endpoint for budgetExhausted().
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";
import { callModel } from "../src/callModel.js";
import { tool } from "../src/tool.js";
import { maxCost, stopOnFallback, stepCountIs, budgetExhausted } from "../src/stop-conditions.js";

/** Build a noop tool so the agent loop keeps iterating (mock always asks to call it). */
async function buildNoopTool() {
  return await tool({
    name: "noop",
    description: "Does nothing — keeps the loop going so stopWhen can fire.",
    inputSchema: z.object({ note: z.string().optional() }),
    execute: async ({ note }) => ({ ack: note ?? "" }),
  });
}

/* ───────────────────────── mock server ───────────────────────── */

type MockOptions = {
  costPerStep: number;
  fallbackOnStep?: number;     // 0-indexed step on which to emit X-HR-Fallback-Used: true
  balanceUsd?: number;          // returned by /credits/balance
  forceTextDelta?: string;
  /** If true (default), every chat completion includes a `noop` tool_call so the
   * loop continues until stopWhen fires. Set false to test natural stop. */
  keepGoing?: boolean;
};

function makeSseChunk(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function startMock(opts: MockOptions): Promise<{ baseUrl: string; close: () => void; callCount: () => number; balanceCalls: () => number }> {
  return new Promise((resolve) => {
    let callCount = 0;
    let balanceCalls = 0;

    const server = http.createServer((req, res) => {
      // /v1/credits/balance — used by budgetExhausted
      if (req.url === "/v1/credits/balance") {
        balanceCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          balance: opts.balanceUsd ?? 10.0,
          totalToppedUp: 100,
          totalUsed: 90,
        }));
        return;
      }

      // /v1/chat/completions — streaming SSE
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        const step = callCount;
        callCount += 1;

        // Drain the body (we don't validate it for these tests).
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const isFallbackStep = opts.fallbackOnStep === step;

          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            // HR response headers (matching what backend actually emits)
            "X-HR-Trace-Id": `mock-trace-${step}`,
            "X-HR-Model-Selected": "anthropic/claude-sonnet-4.6",
            "X-HR-Provider-Selected": "anthropic",
            "X-HR-Fallback-Used": isFallbackStep ? "true" : "false",
            "X-HR-Cost": String(opts.costPerStep),
          });

          const text = opts.forceTextDelta ?? `step-${step}-text `;
          const keepGoing = opts.keepGoing !== false;

          // Streaming chunks: role, content delta, optional tool_call,
          // finish_reason, usage, [DONE].
          res.write(makeSseChunk({
            id: `mock-${step}`,
            object: "chat.completion.chunk",
            created: 0,
            model: "anthropic/claude-sonnet-4.6",
            choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
          }));
          res.write(makeSseChunk({
            id: `mock-${step}`,
            choices: [{ index: 0, delta: { content: text } }],
          }));
          if (keepGoing) {
            // Emit a tool_call so the loop continues past natural stop.
            res.write(makeSseChunk({
              id: `mock-${step}`,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: `call-${step}`,
                    type: "function",
                    function: { name: "noop", arguments: "{}" },
                  }],
                },
              }],
            }));
            res.write(makeSseChunk({
              id: `mock-${step}`,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
          } else {
            res.write(makeSseChunk({
              id: `mock-${step}`,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
          }
          res.write("data: [DONE]\n\n");
          res.end();
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => server.close(),
        callCount: () => callCount,
        balanceCalls: () => balanceCalls,
      });
    });
  });
}

/* ───────────────────────── tests ───────────────────────── */

describe("e2e: SDK ↔ mock HR backend", () => {
  it("reads X-HR-Cost header into per-step costUsd (proves header name fix)", async () => {
    const mock = await startMock({ costPerStep: 0.05, keepGoing: false });
    try {
      const result = callModel(
        {
          model: "anthropic/claude-sonnet-4.6",
          messages: [{ role: "user", content: "hi" }],
          stopWhen: [stepCountIs(1)],
        },
        { apiKey: "hr-test-key", baseUrl: mock.baseUrl },
      );
      const steps = await result.getSteps();
      assert.equal(steps.length, 1);
      assert.equal(steps[0]!.usage.costUsd, 0.05, "costUsd must reflect X-HR-Cost header");
      assert.equal(steps[0]!.routing?.routedModel, "anthropic/claude-sonnet-4.6");
      assert.equal(steps[0]!.routing?.provider, "anthropic");
      assert.equal(steps[0]!.routing?.fallbackUsed, false);
      assert.equal(steps[0]!.routing?.requestId, "mock-trace-0");
    } finally {
      mock.close();
    }
  });

  it("maxCost() stops the loop once cumulative cost reaches the threshold", async () => {
    const mock = await startMock({ costPerStep: 0.20 });
    const noop = await buildNoopTool();
    try {
      const result = callModel(
        {
          model: "anthropic/claude-sonnet-4.6",
          messages: [{ role: "user", content: "hi" }],
          tools: [noop],
          stopWhen: [maxCost(0.5), stepCountIs(10)],
        },
        { apiKey: "hr-test-key", baseUrl: mock.baseUrl },
      );
      const steps = await result.getSteps();
      const usage = await result.getUsage();
      assert.ok(
        usage.costUsd! >= 0.5,
        `cumulative cost should reach ≥0.5, got ${usage.costUsd}`,
      );
      assert.ok(steps.length < 10, "maxCost should have stopped before step 10");
    } finally {
      mock.close();
    }
  });

  it("stopOnFallback() fires when X-HR-Fallback-Used header is 'true'", async () => {
    const mock = await startMock({ costPerStep: 0.01, fallbackOnStep: 1 });
    const noop = await buildNoopTool();
    try {
      const result = callModel(
        {
          model: "anthropic/claude-sonnet-4.6",
          messages: [{ role: "user", content: "hi" }],
          tools: [noop],
          stopWhen: [stopOnFallback(), stepCountIs(10)],
        },
        { apiKey: "hr-test-key", baseUrl: mock.baseUrl },
      );
      const steps = await result.getSteps();
      assert.equal(steps.length, 2, `expected 2 steps, got ${steps.length}`);
      assert.equal(steps[1]!.routing?.fallbackUsed, true);
    } finally {
      mock.close();
    }
  });

  it("budgetExhausted() queries /v1/credits/balance and stops at threshold", async () => {
    const mock = await startMock({ costPerStep: 0.01, balanceUsd: 0 });
    const noop = await buildNoopTool();
    try {
      const result = callModel(
        {
          model: "anthropic/claude-sonnet-4.6",
          messages: [{ role: "user", content: "hi" }],
          tools: [noop],
          stopWhen: [budgetExhausted(), stepCountIs(10)],
        },
        { apiKey: "hr-test-key", baseUrl: mock.baseUrl },
      );
      const steps = await result.getSteps();
      assert.equal(steps.length, 1, "balance=0 should stop after the first step");
      assert.ok(mock.balanceCalls() >= 1, "should have called /credits/balance at least once");
    } finally {
      mock.close();
    }
  });

  it("budgetExhausted() does NOT stop when balance > threshold", async () => {
    const mock = await startMock({ costPerStep: 0.01, balanceUsd: 100 });
    const noop = await buildNoopTool();
    try {
      const result = callModel(
        {
          model: "anthropic/claude-sonnet-4.6",
          messages: [{ role: "user", content: "hi" }],
          tools: [noop],
          stopWhen: [budgetExhausted(), stepCountIs(3)],
        },
        { apiKey: "hr-test-key", baseUrl: mock.baseUrl },
      );
      const steps = await result.getSteps();
      assert.equal(steps.length, 3, "should run all 3 steps when balance is healthy");
    } finally {
      mock.close();
    }
  });
});
