/**
 * Public entry point. Wraps the agent loop with a lazy ModelResult.
 *
 * The result is constructed synchronously — the loop runs on first await of
 * `getText()` / `getSteps()` / `getUsage()` / stream iterators.
 */

import { runAgentLoop } from "./agent-loop.js";
import { resolveConfig } from "./http-client.js";
import type {
  CallModelInput,
  ModelResult,
  RequestOptions,
  StepResult,
  StreamItem,
  ToolCallRequest,
  Usage,
} from "./types.js";

let _traceCounter = 0;
function newTraceId(prefix = "agent"): string {
  _traceCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_traceCounter}`;
}

export function callModel(input: CallModelInput, options: RequestOptions = {}): ModelResult {
  const config = resolveConfig(options);
  const traceId = input.observability?.traceId ?? newTraceId();

  // Lazy: hold a promise that resolves once the loop has run end-to-end.
  // Multiple result getters share the same promise.
  let cached: ReturnType<typeof runAgentLoop> | null = null;
  const ensureRun = () => {
    if (!cached) cached = runAgentLoop({ config, input, traceId });
    return cached;
  };

  const result: ModelResult = {
    async getText() {
      const { finalMessage } = await ensureRun();
      if (typeof finalMessage.content === "string") return finalMessage.content;
      // Compose multi-part assistant message into a single string.
      return (finalMessage.content as Array<{ type: string; text?: string }>)
        .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
        .join("");
    },
    async getSteps(): Promise<StepResult[]> {
      const { steps } = await ensureRun();
      return steps;
    },
    async getUsage(): Promise<Usage> {
      const { usage } = await ensureRun();
      return usage;
    },
    getTraceId(): string {
      return traceId;
    },
    getTextStream(): AsyncIterable<string> {
      return textStreamFromResult(ensureRun);
    },
    getItemsStream(): AsyncIterable<StreamItem> {
      return itemsStreamFromResult(ensureRun);
    },
    getToolCallsStream(): AsyncIterable<ToolCallRequest> {
      return toolCallsStreamFromResult(ensureRun);
    },
  };

  return result;
}

async function* textStreamFromResult(
  ensureRun: () => ReturnType<typeof runAgentLoop>,
): AsyncIterable<string> {
  // Phase-1 implementation: not true streaming. Awaits the full loop then
  // yields the final text as a single chunk. Phase-2 will switch to true SSE
  // streaming via the underlying chat.completions endpoint.
  const { finalMessage } = await ensureRun();
  const text =
    typeof finalMessage.content === "string"
      ? finalMessage.content
      : (finalMessage.content as Array<{ type: string; text?: string }>)
          .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
          .join("");
  yield text;
}

async function* itemsStreamFromResult(
  ensureRun: () => ReturnType<typeof runAgentLoop>,
): AsyncIterable<StreamItem> {
  const { steps, stopReason } = await ensureRun();
  for (const step of steps) {
    for (const tc of step.toolCalls) {
      yield { type: "tool-call", toolCall: tc.request, stepIndex: step.index };
      if (tc.output !== undefined) {
        yield {
          type: "tool-result",
          toolCallId: tc.request.id,
          output: tc.output,
          stepIndex: step.index,
        };
      }
    }
    yield { type: "step-finish", step };
  }
  yield { type: "stop", reason: { matched: stopReason.name, message: `loop stopped: ${stopReason.name}` } };
}

async function* toolCallsStreamFromResult(
  ensureRun: () => ReturnType<typeof runAgentLoop>,
): AsyncIterable<ToolCallRequest> {
  const { steps } = await ensureRun();
  for (const step of steps) {
    for (const tc of step.toolCalls) {
      yield tc.request;
    }
  }
}
