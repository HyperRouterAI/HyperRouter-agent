/**
 * Customer support agent — multi-turn dialog backed by an in-memory knowledge
 * base. Demonstrates conversation state + a search-kb tool.
 *
 * For a real deployment: swap the KB for vector search (pgvector, pinecone,
 * etc.) and persist the messages array between turns.
 *
 * Run:
 *   export HYPERROUTER_API_KEY=hr-...
 *   npx tsx examples/customer-support.ts
 */

import { callModel, tool, stepCountIs } from "@hyperrouter/agent";
import { z } from "zod";
import { createInterface } from "node:readline";

// In-memory KB. In production this becomes a vector store.
const KB: Array<{ id: string; topic: string; content: string }> = [
  {
    id: "k1",
    topic: "billing",
    content:
      "Refunds are issued within 30 days of purchase. Contact support@example.com with your order ID. Pro-rated refunds are not offered.",
  },
  {
    id: "k2",
    topic: "shipping",
    content:
      "Standard shipping is 5-7 business days within the US. Expedited shipping (2 days) costs an extra $15. We ship internationally to 40+ countries.",
  },
  {
    id: "k3",
    topic: "returns",
    content:
      "Items can be returned within 60 days in original condition. Print a prepaid return label from your account dashboard.",
  },
];

const searchKB = await tool({
  name: "search_knowledge_base",
  description: "Search the support knowledge base. Returns matching articles.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    const q = query.toLowerCase();
    const hits = KB.filter((k) => k.topic.includes(q) || k.content.toLowerCase().includes(q));
    return hits.length > 0 ? { hits } : { hits: [], hint: "No articles matched. Try a different keyword." };
  },
});

const SYSTEM_PROMPT =
  "You are a friendly customer support agent. Always search the knowledge base before answering. If the KB doesn't cover the question, say you'll escalate to a human and ask for an email address.";

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  console.log("Customer support agent ready. Type 'quit' to exit.\n");
  while (true) {
    const userInput = (await ask("You: ")).trim();
    if (!userInput || userInput.toLowerCase() === "quit") break;
    messages.push({ role: "user", content: userInput });

    const result = callModel({
      model: "anthropic/claude-sonnet-4.6",
      messages,
      tools: [searchKB],
      stopWhen: stepCountIs(5),
    });

    process.stdout.write("Agent: ");
    for await (const chunk of result.getTextStream()) process.stdout.write(chunk);
    console.log("\n");
    messages.push({ role: "assistant", content: await result.getText() });
  }
  rl.close();
}

main().catch(console.error);
