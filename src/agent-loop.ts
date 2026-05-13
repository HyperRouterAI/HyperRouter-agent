/**
 * The core agent loop. Given an initial set of messages and tools, runs the
 * model → tool-dispatch → model → ... cycle until a stop condition fires or
 * the model returns finish_reason != "tool_calls".
 */

import { postChatCompletions, type HttpClientConfig } from "./http-client.js";
import { evaluateStopConditions, asCondition } from "./stop-conditions.js";
import type {
  AgentState,
  CallModelInput,
  FinishReason,
  Message,
  RoutingMeta,
  StepResult,
  StopCondition,
  Tool,
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
    routedModel: headers.get("x-hr-routed-model") ?? undefined,
    provider: headers.get("x-hr-provider") ?? undefined,
    fallbackUsed: fallback === "true" || fallback === "1",
    requestId: headers.get("x-hr-request-id") ?? undefined,
  };
}

function parseCostHeader(headers: Headers): number | undefined {
  const raw = headers.get("x-hr-cost-usd");
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

export interface RunLoopOptions {
  config: HttpClientConfig;
  input: CallModelInput;
  traceId: string;
}

export interface LoopResult {
  steps: StepResult[];
  finalMessage: Message;
  usage: Usage;
  stopReason: { name: string };
}

export async function runAgentLoop({ config, input, traceId }: RunLoopOptions): Promise<LoopResult> {
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
  let lastFinishReason: FinishReason = "unknown";

  for (let stepIndex = 0; ; stepIndex++) {
    const { response, headers } = await postChatCompletions(
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
      },
      traceId,
      input.signal,
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("Hyper Router returned no choices in response");
    }
    const assistantMessage: Message = {
      role: "assistant",
      content: choice.message.content ?? "",
      tool_calls: choice.message.tool_calls,
    };
    const finishReason = normalizeFinishReason(choice.finish_reason);
    lastFinishReason = finishReason;
    const routing = parseRoutingHeaders(headers);
    if (routing.fallbackUsed) fallbackUsedAnyStep = true;

    const stepUsage: Usage = {
      input: response.usage?.prompt_tokens ?? 0,
      output: response.usage?.completion_tokens ?? 0,
      total: response.usage?.total_tokens ?? 0,
      cacheRead: response.usage?.prompt_tokens_details?.cached_tokens ?? response.usage?.cache_read_input_tokens,
      cacheWrite: response.usage?.cache_creation_input_tokens,
      costUsd: parseCostHeader(headers),
    };

    cumUsage.input += stepUsage.input;
    cumUsage.output += stepUsage.output;
    cumUsage.total += stepUsage.total;
    if (stepUsage.costUsd) cumCostUsd += stepUsage.costUsd;
    cumUsage.costUsd = cumCostUsd;

    // Execute requested tool calls, if any.
    const toolCallsExecuted: StepResult["toolCalls"] = [];
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      for (const tc of choice.message.tool_calls) {
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
          messages.push(assistantMessage);
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
              messages.push(assistantMessage);
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify({ rejected: true, reason }),
              });
              continue;
            }
          }
          const output = await toolImpl.execute(parsed, ctx);
          if (toolImpl.onResponseReceived) {
            toolImpl.onResponseReceived(parsed, output, ctx);
          }
          toolCallsExecuted.push({ request: tc, output });
          // Push assistant + tool result back into the conversation.
          // (We only push assistant message once per step — handled below.)
          messages.push(assistantMessage);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content:
              typeof output === "string" ? output : JSON.stringify(output),
          });
        } catch (e) {
          const err = {
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
          };
          toolCallsExecuted.push({ request: tc, error: err });
          messages.push(assistantMessage);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: err.message }),
          });
        }
      }
    } else {
      // No tool calls — just record the assistant message.
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

    // Build state for stop-condition evaluation
    const state: AgentState = {
      steps,
      usage: cumUsage,
      totalCostUsd: cumCostUsd,
      finishReason,
      fallbackUsed: fallbackUsedAnyStep,
    };

    // Natural stop: no tool calls and finish_reason indicates completion.
    if (
      (!choice.message.tool_calls || choice.message.tool_calls.length === 0) &&
      finishReason !== "tool_calls"
    ) {
      return {
        steps,
        finalMessage: assistantMessage,
        usage: cumUsage,
        stopReason: { name: "natural" },
      };
    }

    // User-supplied stop conditions
    const matched = await evaluateStopConditions(stopConditions, state);
    if (matched) {
      return {
        steps,
        finalMessage: assistantMessage,
        usage: cumUsage,
        stopReason: matched,
      };
    }

    // Loop continues.
  }
}

/** Re-exported for tests / introspection. */
export { asCondition };
export type { AgentState };
