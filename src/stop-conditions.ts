/**
 * Stop conditions for the agent loop. Pass to `callModel({ stopWhen: [...] })`.
 *
 * Built-ins:
 *   stepCountIs(n)         — stop after n steps
 *   maxTokensUsed(n)       — cumulative token cap
 *   maxCost(usd)           — cumulative USD cap (HR cost reporting)
 *   hasToolCall(name)      — stop when a specific tool gets invoked
 *   finishReasonIs(reason) — stop when the model returns this finish_reason
 *   stopOnFallback()       — HR-specific: stop if HR fell back to a different model
 *   budgetExhausted()      — HR-specific: stop if the HR account credits drop to ≤ 0
 *
 * You can also pass a custom function: `({ steps, usage, ... }) => boolean`.
 */

import type { StopCondition, StopConditionFn, AgentState } from "./types.js";

function named(name: string, check: StopConditionFn): StopCondition {
  return { name, check };
}

export function stepCountIs(n: number): StopCondition {
  return named(`stepCountIs(${n})`, ({ steps }) => steps.length >= n);
}

export function maxTokensUsed(n: number): StopCondition {
  return named(`maxTokensUsed(${n})`, ({ usage }) => usage.total >= n);
}

/**
 * Stop once cumulative cost (across all steps in this callModel run) reaches
 * the threshold in USD. HR returns per-step cost in the `x-hr-cost-usd`
 * response header; we sum these into `totalCostUsd`.
 */
export function maxCost(usd: number): StopCondition {
  return named(`maxCost(${usd})`, ({ totalCostUsd }) => totalCostUsd >= usd);
}

export function hasToolCall(name: string): StopCondition {
  return named(`hasToolCall(${name})`, ({ steps }) =>
    steps.some((s) => s.toolCalls.some((tc) => tc.request.function.name === name)),
  );
}

export function finishReasonIs(reason: string): StopCondition {
  return named(`finishReasonIs(${reason})`, ({ finishReason }) => finishReason === reason);
}

/**
 * HR-specific: stop if any step's response indicated HR fell back to a
 * different model (e.g. primary model rate-limited, switched to fallback).
 * Useful when the user explicitly only wants the primary model and would
 * rather error out than silently get a different one.
 */
export function stopOnFallback(): StopCondition {
  return named("stopOnFallback", ({ fallbackUsed }) => fallbackUsed);
}

/**
 * HR-specific: stop if a budget check via HR `/credits` API returns ≤ 0.
 * Called at most once per step (not per token). Useful for hard cost ceilings.
 *
 * NOTE: requires the runtime to have a way to call HR's credits endpoint —
 * the SDK handles this internally if you pass an apiKey.
 */
export function budgetExhausted(opts?: { thresholdUsd?: number }): StopCondition {
  const threshold = opts?.thresholdUsd ?? 0;
  return named(`budgetExhausted(threshold=${threshold})`, async (state) => {
    // The real check is wired in agent-loop.ts where we have HTTP access.
    // We pass through a hint in the state by inspecting headers; if not
    // present, the loop should call /credits separately.
    // This sentinel just expresses the intent; the loop handles fetching.
    return false; // overridden by the loop
  });
}

/** Coerce a user-supplied StopCondition to its check function with a name. */
export function asCondition(c: StopCondition): { name: string; check: StopConditionFn } {
  if (typeof c === "function") {
    return { name: "custom", check: c };
  }
  return c;
}

/** Evaluate a list of stop conditions OR-wise; return the first match or null. */
export async function evaluateStopConditions(
  conditions: StopCondition[],
  state: AgentState,
): Promise<{ name: string } | null> {
  for (const c of conditions) {
    const wrapped = asCondition(c);
    const result = await wrapped.check(state);
    if (result) return { name: wrapped.name };
  }
  return null;
}
