# Examples

Runnable example agents using `@hyperrouter/agent`. Each file is a standalone TypeScript program.

## Setup

```bash
npm install @hyperrouter/agent zod tsx
export HYPERROUTER_API_KEY=hr-...
```

## Run

```bash
npx tsx examples/<name>.ts
```

## Examples

| File | What it shows |
|---|---|
| `weather-tool.ts` | External API + Zod schema + error handling |
| `streaming-chat.ts` | Real-time `getTextStream()` to the terminal |
| `research-bot.ts` | Multi-tool agent (search + fetch) with step + cost caps |
| `coding-agent.ts` | Read / write local files, agentic edit loop |
| `pr-reviewer.ts` | Review a GitHub PR diff (uses `gh` CLI) |
| `code-review-bot.ts` | Review local `git diff` and flag issues |
| `customer-support.ts` | Multi-turn dialog with an in-memory knowledge base |
| `cost-capped-agent.ts` | Showcases `maxCost` + `stopOnFallback` HR-native stop conditions |

Each example is intentionally one file, self-contained, ~50–100 lines. Treat them as starting points to copy and adapt.
