/** Shared types for @hyperrouter/agent. */

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessagePart[];
  /** For tool messages: id of the tool_call this is replying to. */
  tool_call_id?: string;
  /** For assistant messages: tool calls the model is requesting. */
  tool_calls?: ToolCallRequest[];
  /** Optional name (e.g. tool name on tool messages). */
  name?: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCallRequest {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded string. */
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema. */
  parameters: Record<string, unknown>;
}

/** A runnable tool. The user wraps this via `tool()`. */
export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Validate + parse raw JSON args into typed input. */
  parseInput: (rawArgs: string) => TInput;
  /** Execute the tool. */
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
  /** Optional: called before execute. Return { approved: false } to skip. */
  onToolCalled?: (input: TInput, ctx: ToolContext) => Promise<ToolApproval> | ToolApproval;
  /** Optional: called after execute completes successfully. */
  onResponseReceived?: (input: TInput, output: TOutput, ctx: ToolContext) => void;
}

export interface ToolContext {
  /** Step index in the agent loop (0-based). */
  step: number;
  /** Tool-call id from the model response. */
  toolCallId: string;
  /** Trace id propagated to HR for observability. */
  traceId: string;
  /** AbortSignal for the overall callModel — honor this in long-running tools. */
  signal: AbortSignal;
}

export type ToolApproval = { approved: true } | { approved: false; reason?: string };

export interface Usage {
  input: number;
  output: number;
  total: number;
  /** Cost in USD, surfaced by HR usage headers. */
  costUsd?: number;
  /** Cached read tokens (if HR or upstream provider supports it). */
  cacheRead?: number;
  /** Cached write tokens. */
  cacheWrite?: number;
}

export interface StepResult {
  /** Step index (0-based). */
  index: number;
  /** Assistant message returned by the model on this step. */
  message: Message;
  /** Tool calls in this step, with their resolved outputs (or errors). */
  toolCalls: Array<{
    request: ToolCallRequest;
    output?: unknown;
    error?: { message: string; stack?: string };
  }>;
  /** Usage for this single step (not cumulative). */
  usage: Usage;
  /** finish_reason returned by the model. */
  finishReason: FinishReason;
  /** Routing metadata from HR response headers. */
  routing?: RoutingMeta;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "unknown";

export interface RoutingMeta {
  /** Model that actually served the request (from x-hr-routed-model header). */
  routedModel?: string;
  /** Provider upstream that served (e.g. "anthropic", "fireworks"). */
  provider?: string;
  /** Whether HR triggered a fallback to a different model. */
  fallbackUsed?: boolean;
  /** HR request id for tracing. */
  requestId?: string;
}

/** Input to `callModel()`. */
export interface CallModelInput {
  /** Model id or fallback chain. */
  model: string | string[];
  messages: Message[];
  /**
   * Tools the model can call. `Tool<any, any>` (not `Tool<unknown, unknown>`)
   * because each tool has concrete TInput/TOutput types and TypeScript
   * invariance would otherwise reject mixed arrays.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Array<Tool<any, any>>;
  /** Stop condition(s). OR-combined: any one matching stops the loop. */
  stopWhen?: StopCondition | StopCondition[];
  /** Sampling temperature. */
  temperature?: number;
  /** Maximum output tokens per call. */
  maxTokens?: number;
  /** Generic OpenAI-compatible knobs. */
  topP?: number;
  /** System prompt shorthand (prepended to messages if set and no system role exists). */
  system?: string;
  /** HR-specific routing controls (sent as extra_body.routing). */
  routing?: {
    strategy?: "auto" | "cost" | "speed" | "quality";
  };
  /** HR-specific BYOK controls (sent as extra_body.byok). */
  byok?: { strict?: boolean; disabled?: boolean };
  /**
   * Observability options for the agent loop.
   *
   * - `traceId` / `sessionId`: identifiers the SDK threads through every
   *   /v1/chat/completions request in this loop. The HR backend writes
   *   `session_id` onto each `usage_logs` row, so all steps of one
   *   `callModel()` are grouped in the HR Dashboard's Logs → Sessions tab.
   * - `disabled` / `endpoint`: reserved for a future first-party telemetry
   *   stream (Phase 2). They are accepted today but have no effect — the
   *   SDK does not currently post out-of-band step traces to a separate
   *   endpoint. Session attribution is achieved via `session_id` on each
   *   chat completion request.
   */
  observability?: {
    traceId?: string;
    sessionId?: string;
    /** Reserved for Phase 2 — currently a no-op. */
    disabled?: boolean;
    /** Reserved for Phase 2 — currently a no-op. */
    endpoint?: string;
  };
  /** Cancel the overall agent loop. */
  signal?: AbortSignal;
}

export type StopCondition =
  | StopConditionFn
  | { name: string; check: StopConditionFn };

export type StopConditionFn = (state: AgentState) => boolean | Promise<boolean>;

/** State passed to stop conditions on each step. */
export interface AgentState {
  steps: StepResult[];
  usage: Usage;
  /** Cumulative cost in USD. */
  totalCostUsd: number;
  /** Latest finish_reason. */
  finishReason: FinishReason;
  /** Whether HR triggered a model fallback on any step. */
  fallbackUsed: boolean;
}

/** Public result of callModel() — lazy: nothing has been awaited yet. */
export interface ModelResult {
  /** Final assistant text. Throws if loop errored. */
  getText(): Promise<string>;
  /** All steps the loop took. */
  getSteps(): Promise<StepResult[]>;
  /** Cumulative usage across all steps. */
  getUsage(): Promise<Usage>;
  /** Trace id used for HR observability. */
  getTraceId(): string;
  /** Stream just the text deltas from the final assistant message. */
  getTextStream(): AsyncIterable<string>;
  /** Stream every item (messages, tool calls, reasoning blocks) as they emerge. */
  getItemsStream(): AsyncIterable<StreamItem>;
  /** Stream tool calls as the model emits them. */
  getToolCallsStream(): AsyncIterable<ToolCallRequest>;
}

export type StreamItem =
  | { type: "text-delta"; delta: string; stepIndex: number }
  | { type: "tool-call"; toolCall: ToolCallRequest; stepIndex: number }
  | { type: "tool-result"; toolCallId: string; output: unknown; stepIndex: number }
  | { type: "step-finish"; step: StepResult }
  | { type: "stop"; reason: StopReason }
  | { type: "error"; error: Error };

export interface StopReason {
  /** Which stop condition matched (or "natural" / "error"). */
  matched: string;
  /** Human-readable explanation. */
  message: string;
}

export interface RequestOptions {
  /** Hyper Router API key (hr-...). Defaults to env HYPERROUTER_API_KEY. */
  apiKey?: string;
  /** Override base URL. Defaults to https://api.hyperrouter.ai/v1. */
  baseUrl?: string;
  /** Custom fetch implementation (for testing / proxy). */
  fetch?: typeof globalThis.fetch;
  /** Default request timeout (ms). */
  timeoutMs?: number;
}

/* ───────────────────────── Type-inference utilities ─────────────────────────
 *
 * Helpers for users who want to derive types from a tool definition (e.g.
 * to type a React component that displays the tool's input or output).
 *
 * Example:
 *
 *   const search = await tool({
 *     name: "search",
 *     description: "Search the web",
 *     inputSchema: z.object({ query: z.string() }),
 *     execute: async ({ query }) => ({ results: [`hit for ${query}`] }),
 *   });
 *
 *   type SearchInput  = InferToolInput<typeof search>;   // { query: string }
 *   type SearchOutput = InferToolOutput<typeof search>;  // { results: string[] }
 *
 *   function SearchCard({ call }: { call: TypedToolCall<typeof search> }) {
 *     return <pre>{JSON.stringify(call.input, null, 2)}</pre>;
 *   }
 */

/** Extract a tool's input type. */
export type InferToolInput<T> = T extends Tool<infer I, unknown> ? I : never;

/** Extract a tool's output type. */
export type InferToolOutput<T> = T extends Tool<unknown, infer O> ? O : never;

/** A tool-call request narrowed to a specific tool's input type. */
export interface TypedToolCall<T> {
  id: string;
  toolName: T extends Tool<unknown, unknown> ? string : never;
  input: InferToolInput<T>;
}
