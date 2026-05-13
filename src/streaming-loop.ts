/**
 * Stream-first agent loop. Each step uses /v1/chat/completions with stream=true,
 * yields text deltas as they arrive, then dispatches tool calls when the
 * stream completes, and feeds results back to the next step.
 *
 * Events are pushed into a Channel that callModel result getters subscribe to.
 *
 * Replaces the buffer-based loop in agent-loop.ts for callModel's main flow.
 * The buffer loop is kept as a fallback for cases where streaming fails or is
 * disabled.
 */

import { postChatCompletionsStream, getBalance, type HttpClientConfig } from "./http-client.js";
import { parseSseStream, chunkText, chunkToolCallDeltas, chunkFinishReason } from "./sse.js";
import { evaluateStopConditions, asCondition } from "./stop-conditions.js";
import { Channel } from "./channel.js";
import type {
  AgentState,
  CallModelInput,
  FinishReason,
  Message,
  RoutingMeta,
  StepResult,
  StopCondition,
  StreamItem,
  Tool,
  ToolCallRequest,
  ToolContext,
  Usage,
} from "./types.js";

const FINISH_REASON_MAP: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "content_filter",
  error: "error",
};

function normalizeFinishReason(raw: string | undefined): FinishReason {
  if (!raw) return "unknown";
  return FINISH_REASON_MAP[raw] ?? "unknown";
}

function parseRoutingHeaders(headers: Headers): RoutingMeta {
  const fallback = headers.get("x-hr-fallback-used");
  return {
    // Header names match what HR backend emits today (src/routes/chat.ts +
    // src/server.ts CORS expose list). Do NOT rename without grepping the
    // backend - this is the public contract.
    routedModel: headers.get("x-hr-model-selected") ?? undefined,
    provider: headers.get("x-hr-provider-selected") ?? undefined,
    fallbackUsed: fallback === "true" || fallback === "1",
    requestId: headers.get("x-hr-trace-id") ?? undefined,
  };
}

function parseCostHeader(headers: Headers): number | undefined {
  const raw = headers.get("x-hr-cost");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function buildMessagesWithSystem(input: CallModelInput): Message[] {
  if (!input.system) return input.messages;
  if (input.messages.some((m) => m.role === "system")) return input.messages;
  return [{ role: "system", content: input.system }, ...input.messages];
}

function toToolsPayload(tools: Tool[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsBuffer: string;
}

/** Apply incremental tool_call deltas from an SSE chunk to in-flight accumulators. */
function applyToolCallDelta(
  accs: Map<number, ToolCallAccumulator>,
  delta: ReturnType<typeof chunkToolCallDeltas>[number],
): void {
  const idx = delta.index ?? 0;
  let acc = accs.get(idx);
  if (!acc) {
    acc = { id: delta.id ?? "", name: delta.function?.name ?? "", argsBuffer: "" };
    accs.set(idx, acc);
  }
  if (delta.id) acc.id = delta.id;
  if (delta.function?.name) acc.name = delta.function.name;
  if (delta.function?.arguments) acc.argsBuffer += delta.function.arguments;
}

export interface RunStreamingLoopOptions {
  config: HttpClientConfig;
  input: CallModelInput;
  traceId: string;
  /** Channel to push StreamItem events into. */
  channel: Channel<StreamItem>;
}

export interface StreamingLoopResult {
  steps: StepResult[];
  finalMessage: Message;
  usage: Usage;
  stopReason: { name: string };
}

export async function runAgentLoopStreaming(
  opts: RunStreamingLoopOptions,
): Promise<StreamingLoopResult> {
  const { config, input, traceId, channel } = opts;
  const tools = input.tools ?? [];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolsPayload = toToolsPayload(tools);
  const stopConditions: StopCondition[] = Array.isArray(input.stopWhen)
    ? input.stopWhen
    : input.stopWhen
      ? [input.stopWhen]
      : [];

  const messages: Message[] = buildMessagesWithSystem(input).slice();
  const steps: StepResult[] = [];
  const cumUsage: Usage = { input: 0, output: 0, total: 0, costUsd: 0 };
  let cumCostUsd = 0;
  let fallbackUsedAnyStep = false;

  // Use the trace id as session_id so every chat completion in this loop is
  // grouped under one session in the HR Dashboard's Logs → Sessions tab.
  // Capped at 200 chars (HR backend limit).
  const sessionId = (input.observability?.sessionId ?? traceId).slice(0, 200);

  for (let stepIndex = 0; ; stepIndex++) {
    const { stream, headers } = await postChatCompletionsStream(
      config,
      {
        model: input.model,
        messages,
        tools: toolsPayload,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        top_p: input.topP,
        routing: input.routing,
        byok: input.byok,
        session_id: sessionId,
      },
      traceId,
      input.signal,
    );

    const routing = parseRoutingHeaders(headers);
    if (routing.fallbackUsed) fallbackUsedAnyStep = true;
    const stepCost = parseCostHeader(headers);

    // Accumulate as the stream comes in.
    let textBuffer = "";
    const toolAccs = new Map<number, ToolCallAccumulator>();
    let rawFinishReason: string | undefined;
    let stepUsage: Usage = { input: 0, output: 0, total: 0, costUsd: stepCost };

    for await (const chunk of parseSseStream(stream)) {
      const delta = chunkText(chunk);
      if (delta) {
        textBuffer += delta;
        channel.push({ type: "text-delta", delta, stepIndex });
      }
      for (const tcd of chunkToolCallDeltas(chunk)) {
        applyToolCallDelta(toolAccs, tcd);
      }
      const fr = chunkFinishReason(chunk);
      if (fr) rawFinishReason = fr;
      if (chunk.usage) {
        stepUsage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
          total: chunk.usage.total_tokens ?? 0,
          cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens,
          costUsd: stepCost,
        };
      }
    }

    const finishReason = normalizeFinishReason(rawFinishReason);
    cumUsage.input += stepUsage.input;
    cumUsage.output += stepUsage.output;
    cumUsage.total += stepUsage.total;
    if (stepUsage.costUsd) cumCostUsd += stepUsage.costUsd;
    cumUsage.costUsd = cumCostUsd;

    // Reconstruct tool_call array from accumulators.
    const toolCallsArr: ToolCallRequest[] = Array.from(toolAccs.values()).map((a) => ({
      id: a.id,
      type: "function" as const,
      function: { name: a.name, arguments: a.argsBuffer },
    }));

    const assistantMessage: Message = {
      role: "assistant",
      content: textBuffer,
      tool_calls: toolCallsArr.length > 0 ? toolCallsArr : undefined,
    };

    // Dispatch tool calls (if any). Always push the assistant message first,
    // then each tool's reply, mirroring buffer-loop semantics.
    const toolCallsExecuted: StepResult["toolCalls"] = [];
    if (toolCallsArr.length > 0) {
      messages.push(assistantMessage);
      for (const tc of toolCallsArr) {
        channel.push({ type: "tool-call", toolCall: tc, stepIndex });
        const toolImpl = toolsByName.get(tc.function.name);
        const ctx: ToolContext = {
          step: stepIndex,
          toolCallId: tc.id,
          traceId,
          signal: input.signal ?? new AbortController().signal,
        };

        if (!toolImpl) {
          const err = { message: `Unknown tool requested by model: ${tc.function.name}` };
          toolCallsExecuted.push({ request: tc, error: err });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: err.message }),
          });
          continue;
        }
        try {
          const parsed = toolImpl.parseInput(tc.function.arguments);
          if (toolImpl.onToolCalled) {
            const approval = await toolImpl.onToolCalled(parsed, ctx);
            if (!approval.approved) {
              const reason = approval.reason ?? "tool call rejected by approval hook";
              toolCallsExecuted.push({ request: tc, error: { message: reason } });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({ rejected: true, reason }),
              });
              continue;
            }
          }
          const output = await toolImpl.execute(parsed, ctx);
          if (toolImpl.onResponseReceived) toolImpl.onResponseReceived(parsed, output, ctx);
          toolCallsExecuted.push({ request: tc, output });
          channel.push({ type: "tool-result", toolCallId: tc.id, output, stepIndex });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: typeof output === "string" ? output : JSON.stringify(output),
          });
        } catch (e) {
          const err = {
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
          };
          toolCallsExecuted.push({ request: tc, error: err });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: err.message }),
          });
        }
      }
    } else {
      messages.push(assistantMessage);
    }

    const stepResult: StepResult = {
      index: stepIndex,
      message: assistantMessage,
      toolCalls: toolCallsExecuted,
      usage: stepUsage,
      finishReason,
      routing,
    };
    steps.push(stepResult);
    channel.push({ type: "step-finish", step: stepResult });

    // Natural stop
    if (toolCallsArr.length === 0 && finishReason !== "tool_calls") {
      channel.push({ type: "stop", reason: { matched: "natural", message: "model finished without tool calls" } });
      return {
        steps,
        finalMessage: assistantMessage,
        usage: cumUsage,
        stopReason: { name: "natural" },
      };
    }

    // budgetExhausted() is special: its check function is a stub that always
    // returns false (it has no HTTP access). We detect it by name, fetch the
    // balance from /v1/credits/balance, and inject the result here.
    const budgetCond = stopConditions
      .map((c) => asCondition(c))
      .find((c) => c.name.startsWith("budgetExhausted"));
    if (budgetCond) {
      const threshold = parseBudgetThreshold(budgetCond.name);
      try {
        const balance = await getBalance(config, input.signal);
        if (balance.balance <= threshold) {
          channel.push({
            type: "stop",
            reason: {
              matched: budgetCond.name,
              message: `loop stopped: balance=${balance.balance} <= ${threshold}`,
            },
          });
          return {
            steps,
            finalMessage: assistantMessage,
            usage: cumUsage,
            stopReason: { name: budgetCond.name },
          };
        }
      } catch {
        // Balance fetch failed — don't fail the agent; just skip this check.
      }
    }

    // User-supplied stop conditions
    const state: AgentState = {
      steps,
      usage: cumUsage,
      totalCostUsd: cumCostUsd,
      finishReason,
      fallbackUsed: fallbackUsedAnyStep,
    };
    const matched = await evaluateStopConditions(stopConditions, state);
    if (matched) {
      channel.push({ type: "stop", reason: { matched: matched.name, message: `loop stopped: ${matched.name}` } });
      return {
        steps,
        finalMessage: assistantMessage,
        usage: cumUsage,
        stopReason: matched,
      };
    }
  }
}

function parseBudgetThreshold(name: string): number {
  const m = name.match(/threshold=([\d.]+)/);
  return m ? Number(m[1]) : 0;
}
