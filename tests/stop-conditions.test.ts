import { describe, it, expect } from "vitest";
import {
  stepCountIs,
  maxTokensUsed,
  maxCost,
  hasToolCall,
  finishReasonIs,
  stopOnFallback,
  asCondition,
  evaluateStopConditions,
} from "../src/stop-conditions.js";
import type { AgentState, StepResult, Usage } from "../src/types.js";

function fakeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    index: 0,
    message: { role: "assistant", content: "" },
    toolCalls: [],
    usage: { input: 0, output: 0, total: 0 },
    finishReason: "stop",
    ...overrides,
  };
}

function fakeState(overrides: Partial<AgentState> = {}): AgentState {
  const usage: Usage = { input: 0, output: 0, total: 0, costUsd: 0 };
  return {
    steps: [],
    usage,
    totalCostUsd: 0,
    finishReason: "stop",
    fallbackUsed: false,
    ...overrides,
  };
}

describe("stop conditions", () => {
  it("stepCountIs fires when N steps reached", async () => {
    const cond = asCondition(stepCountIs(3));
    expect(await cond.check(fakeState({ steps: [fakeStep(), fakeStep()] }))).toBe(false);
    expect(await cond.check(fakeState({ steps: [fakeStep(), fakeStep(), fakeStep()] }))).toBe(true);
  });

  it("maxTokensUsed fires when cumulative tokens reach threshold", async () => {
    const cond = asCondition(maxTokensUsed(100));
    expect(await cond.check(fakeState({ usage: { input: 30, output: 40, total: 70 } }))).toBe(false);
    expect(await cond.check(fakeState({ usage: { input: 60, output: 50, total: 110 } }))).toBe(true);
  });

  it("maxCost fires on cumulative USD", async () => {
    const cond = asCondition(maxCost(0.5));
    expect(await cond.check(fakeState({ totalCostUsd: 0.4 }))).toBe(false);
    expect(await cond.check(fakeState({ totalCostUsd: 0.5 }))).toBe(true);
    expect(await cond.check(fakeState({ totalCostUsd: 1.2 }))).toBe(true);
  });

  it("hasToolCall fires when the named tool appears in any step", async () => {
    const cond = asCondition(hasToolCall("search"));
    const stepWithoutSearch = fakeStep({
      toolCalls: [{ request: { id: "1", type: "function", function: { name: "other", arguments: "{}" } } }],
    });
    const stepWithSearch = fakeStep({
      toolCalls: [{ request: { id: "2", type: "function", function: { name: "search", arguments: "{}" } } }],
    });
    expect(await cond.check(fakeState({ steps: [stepWithoutSearch] }))).toBe(false);
    expect(await cond.check(fakeState({ steps: [stepWithoutSearch, stepWithSearch] }))).toBe(true);
  });

  it("finishReasonIs fires only on exact match", async () => {
    const cond = asCondition(finishReasonIs("length"));
    expect(await cond.check(fakeState({ finishReason: "stop" }))).toBe(false);
    expect(await cond.check(fakeState({ finishReason: "length" }))).toBe(true);
  });

  it("stopOnFallback fires when any step used a fallback", async () => {
    const cond = asCondition(stopOnFallback());
    expect(await cond.check(fakeState({ fallbackUsed: false }))).toBe(false);
    expect(await cond.check(fakeState({ fallbackUsed: true }))).toBe(true);
  });

  it("custom function works as a condition", async () => {
    const cond = asCondition(({ steps }) => steps.length >= 2 && steps[0]!.usage.total > 50);
    expect(await cond.check(fakeState({ steps: [fakeStep({ usage: { input: 30, output: 30, total: 60 } })] }))).toBe(false);
    expect(
      await cond.check(
        fakeState({
          steps: [
            fakeStep({ usage: { input: 30, output: 30, total: 60 } }),
            fakeStep(),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("evaluateStopConditions returns first match (OR-combined)", async () => {
    const result = await evaluateStopConditions(
      [stepCountIs(99), maxCost(0.5)],
      fakeState({ totalCostUsd: 1.0 }),
    );
    expect(result?.name).toBe("maxCost(0.5)");
  });

  it("evaluateStopConditions returns null when nothing matches", async () => {
    const result = await evaluateStopConditions(
      [stepCountIs(99), maxCost(99)],
      fakeState({ steps: [fakeStep()], totalCostUsd: 0.1 }),
    );
    expect(result).toBeNull();
  });
});
