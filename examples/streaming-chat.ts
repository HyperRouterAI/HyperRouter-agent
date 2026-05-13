/**
 * Streaming chat — tokens print to the terminal as the model generates them.
 *
 * Run:
 *   export HYPERROUTER_API_KEY=hr-...
 *   npx tsx examples/streaming-chat.ts
 */

import { callModel } from "@hyperrouter/agent";

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    { role: "system", content: "You are a creative writer." },
    { role: "user", content: "Write a one-paragraph story about a cat learning to code." },
  ],
});

// Stream tokens as they arrive. No tool dispatch needed for plain chat —
// the loop runs once, streams text, and finishes naturally.
for await (const chunk of result.getTextStream()) {
  process.stdout.write(chunk);
}

console.log("\n---");
const usage = await result.getUsage();
console.log(`Tokens: ${usage.total} (in: ${usage.input}, out: ${usage.output}) — cost: $${usage.costUsd ?? "?"}`);
