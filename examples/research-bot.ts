/**
 * Research bot — calls a search tool + fetch tool in a loop. Caps at 8 steps
 * or $0.50 cumulative cost (whichever comes first).
 *
 * Replace `webSearch` and `fetchPage` with your own search/fetch backends
 * (Tavily, Brave, SerpAPI, etc.). This example uses fake data so it runs
 * without external setup.
 *
 * Run:
 *   export HYPERROUTER_API_KEY=hr-...
 *   npx tsx examples/research-bot.ts
 */

import { callModel, tool, stepCountIs, maxCost } from "@hyperrouter/agent";
import { z } from "zod";

const search = await tool({
  name: "search",
  description: "Search the web. Returns titles + URLs.",
  inputSchema: z.object({ query: z.string(), limit: z.number().optional().default(5) }),
  execute: async ({ query, limit }) => {
    // Stub. Replace with a real search API.
    return {
      results: Array.from({ length: limit ?? 5 }, (_, i) => ({
        title: `Result ${i + 1} for "${query}"`,
        url: `https://example.com/r${i + 1}`,
        snippet: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
      })),
    };
  },
});

const fetchPage = await tool({
  name: "fetch_page",
  description: "Fetch the readable text content of a URL.",
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    // Stub. Replace with a real fetcher (Jina Reader, Mercury, your own).
    return { url, content: `[content of ${url}] ...` };
  },
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    {
      role: "system",
      content:
        "You are a research agent. Use the search tool to find sources, fetch_page to read them, and synthesize a 3-bullet summary with citations.",
    },
    { role: "user", content: "What are the major Transformer architecture variants since 2023?" },
  ],
  tools: [search, fetchPage],
  // Stop after 8 steps OR $0.50 spent, whichever comes first.
  stopWhen: [stepCountIs(8), maxCost(0.5)],
});

console.log(await result.getText());
console.log("\n---");
const steps = await result.getSteps();
console.log(`Loop ran ${steps.length} step(s).`);
console.log("Usage:", await result.getUsage());
