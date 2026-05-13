# @hyperrouter/agent

Agent loop framework for [Hyper Router](https://hyperrouter.ai). Write multi-step LLM agents without the boilerplate — `callModel()` handles the conversation loop, tool dispatch, stop conditions, and observability.

## Install

```bash
npm install @hyperrouter/agent
# Optional, recommended for typed tool inputs:
npm install zod
```

## Quickstart

```ts
import { callModel, tool, stepCountIs, maxCost } from "@hyperrouter/agent";
import { z } from "zod";

const searchTool = await tool({
  name: "search",
  description: "Search the web for a query",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    return { results: await webSearch(query) };
  },
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    { role: "system", content: "You are a research agent." },
    { role: "user", content: "Find recent news on X" },
  ],
  tools: [searchTool],
  stopWhen: [stepCountIs(10), maxCost(0.5)],
});

console.log(await result.getText());
console.log(await result.getUsage()); // { input, output, total, costUsd }
```

## What it does

- **Conversation loop**: calls model → reads tool_calls → dispatches your tool functions → feeds results back → repeats
- **Stop conditions**: built-in helpers (`stepCountIs`, `maxTokensUsed`, `maxCost`, `hasToolCall`, `finishReasonIs`, `stopOnFallback`, `budgetExhausted`) plus custom predicates
- **Streaming**: text deltas, tool calls, step events as they happen (Phase 2)
- **Type-safe tools**: Zod-schema inputs auto-converted to JSON Schema for the model
- **Approval hooks** (HITL): `tool({ onToolCalled })` to require user confirmation before risky tool calls
- **HR-native observability**: every step is reported to Hyper Router so you can see step trees, cost breakdown, and fallback events in the Dashboard

## API

| Function | What it does |
|---|---|
| `callModel(input, options?)` | Run the agent loop. Returns a lazy `ModelResult`. |
| `tool({ name, description, inputSchema, execute })` | Define a runnable tool (async; supports Zod). |
| `toolSync({...})` | Sync variant — plain JSON Schema only, no Zod. |

### Stop conditions

```ts
import {
  stepCountIs,     // stop after N steps
  maxTokensUsed,   // cumulative token cap
  maxCost,         // cumulative USD cap (HR-reported cost)
  hasToolCall,     // stop when a specific tool runs
  finishReasonIs,  // stop on specific finish_reason
  stopOnFallback,  // HR-only: stop if HR fell back to a different model
  budgetExhausted, // HR-only: stop when HR account credits run out
} from "@hyperrouter/agent";
```

Pass one or many. They're OR-combined.

```ts
stopWhen: [stepCountIs(20), maxCost(1.0)]
```

### Results (`ModelResult`)

| Method | Returns |
|---|---|
| `.getText()` | Final assistant text |
| `.getSteps()` | All `StepResult`s the loop produced |
| `.getUsage()` | Cumulative token + cost usage |
| `.getTraceId()` | Trace id for HR observability |
| `.getTextStream()` | Async iterable of text deltas |
| `.getItemsStream()` | Async iterable of message / tool-call / tool-result events |
| `.getToolCallsStream()` | Async iterable of just tool-call requests |

### HR-native input fields

```ts
callModel({
  // ...
  routing: { strategy: "cost" },           // tell HR's auto router what to optimize for
  byok: { strict: true },                  // require user's BYOK key, never fall back to HR credits
  observability: { traceId: "my-trace-1" }, // override the auto-generated trace id
  signal: abortController.signal,          // cancel the whole loop
});
```

## Authentication

By default reads `HYPERROUTER_API_KEY` from env. Override per-call:

```ts
callModel(input, { apiKey: "hr-..." });
```

## Roadmap

This is Phase 1 (core loop + stop conditions + tools). Coming:

- Phase 2: True SSE streaming (`getTextStream()` currently buffers)
- Phase 3: Observability hooks → Hyper Router DevTools (step-tree visualization)
- Phase 4: `npx @hyperrouter/agent run <skill>` CLI for non-developers
- Phase 5: Examples + docs site integration

## License

MIT
