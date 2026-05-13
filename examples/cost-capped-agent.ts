/**
 * Cost-capped agent — showcases the HR-native stop conditions: `maxCost`
 * (caps cumulative cost across all steps) and `stopOnFallback` (aborts if
 * Hyper Router falls back to a different model than the user requested).
 *
 * Useful pattern when you want strict budget guarantees or strict model
 * adherence in a multi-step agent.
 *
 * Run:
 *   export HYPERROUTER_API_KEY=hr-...
 *   npx tsx examples/cost-capped-agent.ts
 */

import { callModel, tool, stepCountIs, maxCost, stopOnFallback } from "@hyperrouter/agent";
import { z } from "zod";

const slowSearch = await tool({
  name: "deep_research",
  description: "Run an expensive deep-research query. Each call costs a lot of tokens.",
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }) => ({
    sources: Array.from({ length: 10 }, (_, i) => ({
      id: i,
      title: `Long source #${i + 1} about ${topic}`,
      body: "A few thousand tokens of content here in a real implementation.",
    })),
  }),
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  // Optional: a fallback chain. The presence of fallback is what `stopOnFallback`
  // watches for via the x-hr-fallback-used response header.
  // model: ["anthropic/claude-sonnet-4.6", "openai/gpt-4.1"],
  messages: [
    { role: "system", content: "You are a research agent. Use deep_research as needed." },
    { role: "user", content: "Write me a 3-page report on the history of transformer architectures." },
  ],
  tools: [slowSearch],
  // Any one of these matching stops the loop:
  //   - 15 steps max
  //   - 50¢ max cumulative cost
  //   - stop if HR fell back to a non-primary model
  stopWhen: [stepCountIs(15), maxCost(0.5), stopOnFallback()],
});

for await (const chunk of result.getTextStream()) process.stdout.write(chunk);

console.log("\n---");
const usage = await result.getUsage();
const steps = await result.getSteps();
console.log(`Stopped after ${steps.length} step(s).`);
console.log(`Total spent: $${(usage.costUsd ?? 0).toFixed(4)}.`);
console.log(`Final step finish_reason: ${steps[steps.length - 1]?.finishReason}.`);
const fallback = steps.some((s) => s.routing?.fallbackUsed);
console.log(`HR fallback triggered: ${fallback}`);
