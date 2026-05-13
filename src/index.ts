/**
 * @hyperrouter/agent — public API.
 *
 * Quickstart:
 *
 *   import { callModel, tool, stepCountIs, maxCost } from "@hyperrouter/agent";
 *   import { z } from "zod";
 *
 *   const searchTool = await tool({
 *     name: "search",
 *     description: "Search the web",
 *     inputSchema: z.object({ query: z.string() }),
 *     execute: async ({ query }) => ({ results: await webSearch(query) }),
 *   });
 *
 *   const result = callModel({
 *     model: "anthropic/claude-sonnet-4.6",
 *     messages: [{ role: "user", content: "Research X" }],
 *     tools: [searchTool],
 *     stopWhen: [stepCountIs(10), maxCost(0.5)],
 *   });
 *
 *   console.log(await result.getText());
 */

// Main entry
export { callModel } from "./callModel.js";

// Tool builder
export { tool, toolSync, type ToolConfig } from "./tool.js";

// Stop conditions
export {
  stepCountIs,
  maxTokensUsed,
  maxCost,
  hasToolCall,
  finishReasonIs,
  stopOnFallback,
  budgetExhausted,
} from "./stop-conditions.js";

// Errors
export { HyperRouterError, HYPERROUTER_BASE_URL } from "./http-client.js";

// Types
export type {
  Message,
  MessagePart,
  Tool,
  ToolContext,
  ToolCallRequest,
  ToolDefinition,
  ToolApproval,
  Usage,
  StepResult,
  FinishReason,
  RoutingMeta,
  CallModelInput,
  ModelResult,
  StreamItem,
  StopReason,
  StopCondition,
  StopConditionFn,
  AgentState,
  RequestOptions,
} from "./types.js";
