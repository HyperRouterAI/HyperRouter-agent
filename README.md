# @hyperrouter/agent

Agent loop framework for [Hyper Router](https://hyperrouter.ai). Write multi-step LLM agents with first-class cost control — `callModel()` handles the conversation loop, tool dispatch, and 7 stop conditions including HR-only `maxCost` (real-time cumulative cost cap), `stopOnFallback`, and `budgetExhausted` (live account balance check). Every run is auto-grouped as a session in HR Dashboard → Logs.

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
- **Streaming**: text deltas, tool calls, step-finish events as they happen — true SSE under the hood
- **Type-safe tools**: Zod-schema inputs auto-converted to JSON Schema for the model
- **Approval hooks**: `tool({ onToolCalled })` to allow/deny risky tool calls (synchronous; long-running human-in-the-loop pause/resume is on the roadmap)
- **Session-grouped observability**: every chat completion carries a `session_id`, so all steps of one `callModel()` are grouped under one session in HR Dashboard's Logs → Sessions tab

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
| `.getItemsStream()` | Async iterable of every event: `text-delta`, `tool-call`, `tool-result`, `step-finish`, `stop`, `error` |
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

## CLI

The package ships a small CLI for scaffolding and health checks:

```bash
npx @hyperrouter/agent init my-agent   # scaffold a new agent project
npx @hyperrouter/agent run agent.ts    # run a TypeScript agent file via tsx
npx @hyperrouter/agent doctor          # check node version, key, connectivity
npx @hyperrouter/agent --version       # 0.1.0
```

After `init`, the generated project ships with an `agent.ts` template and the right `package.json` to run `npm start`.

## Best practices for tools

### Make tools idempotent

The agent loop may retry a tool call (model re-emits the same call after an error, user replays a session, etc.). If your tool has side effects, design it so calling it twice with the same input is safe — use idempotency keys when writing to external systems, check before insert, etc. A tool that creates a duplicate row on every retry is the #1 production footgun.

```ts
const sendEmail = await tool({
  name: "send_email",
  inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  execute: async ({ to, subject, body }, ctx) => {
    // Use the agent-loop step id as the idempotency key so a retry of the
    // same step is a no-op rather than a second email.
    const idempotencyKey = `${ctx.traceId}-${ctx.step}`;
    return await emailClient.send({ to, subject, body, idempotencyKey });
  },
});
```

### Add a per-tool timeout

A hung tool blocks the entire loop until `signal` fires. Race your work against a tight timeout so a slow upstream surfaces quickly:

```ts
execute: async (input, { signal }) => {
  const result = await Promise.race([
    longRunningWork(input, { signal }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("tool timed out")), 30_000)
    ),
  ]);
  return result;
}
```

### Don't swallow errors

Throw real errors. The loop captures them in `step.toolCalls[i].error`, surfaces them in `getItemsStream()` as `{ type: "error" }`, and the model sees them in the next turn so it can recover or escalate. Returning `{ error: "..." }` as a normal output looks like success to the model and produces silent failure modes.

### Type the I/O at the call site

Use the inference helpers to keep tool consumers in sync with their definitions:

```ts
import type { InferToolInput, InferToolOutput, TypedToolCall } from "@hyperrouter/agent";

type SearchInput  = InferToolInput<typeof searchTool>;
type SearchOutput = InferToolOutput<typeof searchTool>;

function SearchProgress({ call }: { call: TypedToolCall<typeof searchTool> }) {
  return <code>searching for "{call.input.query}"</code>;
}
```

## Roadmap

`0.1.x` ships with the core loop, 7 stop conditions, true SSE streaming, tool dispatch with Zod, an `init / run / doctor` CLI, and session-grouped observability via HR Dashboard.

On the table for future releases (driven by real user feedback):

- Local DevTools — a `localhost:4983` viewer that visualises every `callModel()` run (timeline, request/response inspector, cost breakdown, run diff). Pairs with our existing session traces.
- `nextTurnParams` — let a tool mutate the next turn's `model` / `instructions` / `temperature` (skill loading, cost-aware model escalation).
- Generator tools — `execute: async function* () { yield progress }` so UIs can show in-flight tool progress without leaking it to the model.
- Pause/resume HITL — return a sentinel from `onToolCalled` to suspend the loop until a separate API call resumes it (Devin-style long-running agents).
- Format converters — `fromChatMessages` / `fromClaudeMessages` adapters for one-line migration from OpenAI / Anthropic SDKs.

## License

MIT
