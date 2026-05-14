/** Minimal fetch wrapper for Hyper Router /v1/chat/completions. */

import type { RequestOptions, Message, ToolDefinition } from "./types.js";

export const HYPERROUTER_BASE_URL = "https://api.hyperrouter.ai/v1";

export interface ChatCompletionsRequest {
  model: string;
  /** Multi-model fallback list — HR backend takes this as priority over `model`. */
  models?: string[];
  messages: Message[];
  tools?: Array<{ type: "function"; function: ToolDefinition }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  /** Extra HR-specific knobs sent in the request body. */
  routing?: unknown;
  byok?: unknown;
  /**
   * Session id — groups multiple chat completions into one session in the HR
   * Dashboard's Logs → Sessions tab. The agent SDK uses its traceId here so
   * every step of one callModel() shows up as one session.
   */
  session_id?: string;
}

export interface ChatCompletionsResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: string;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** HR / upstream cache breakdown (when available). */
    prompt_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface HttpClientConfig extends Required<Omit<RequestOptions, "fetch" | "timeoutMs">> {
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

export function resolveConfig(options: RequestOptions = {}): HttpClientConfig {
  const apiKey = options.apiKey ?? process.env.HYPERROUTER_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "Hyper Router API key not found. Pass { apiKey } to callModel or set HYPERROUTER_API_KEY env var.",
    );
  }
  return {
    apiKey,
    baseUrl: options.baseUrl ?? process.env.HYPERROUTER_BASE_URL ?? HYPERROUTER_BASE_URL,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 120_000,
  };
}

export class HyperRouterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "HyperRouterError";
  }
}

/**
 * Streaming variant of {@link postChatCompletions}. Returns the raw response
 * ReadableStream for SSE parsing plus the response headers (for HR routing /
 * cost / fallback metadata). Caller is responsible for consuming the stream
 * via `parseSseStream` from "./sse.js".
 */
export async function postChatCompletionsStream(
  config: HttpClientConfig,
  body: ChatCompletionsRequest,
  traceId: string,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; headers: Headers }> {
  const url = `${config.baseUrl}/chat/completions`;
  const ctl = new AbortController();
  const timeoutId = setTimeout(() => ctl.abort(), config.timeoutMs);
  const combinedSignal = signal ? mergeSignals(signal, ctl.signal) : ctl.signal;

  try {
    const res = await config.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${config.apiKey}`,
        "X-HR-Trace-Id": traceId,
        "User-Agent": "@hyperrouter/agent",
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: combinedSignal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw */
      }
      throw new HyperRouterError(
        `Hyper Router request failed with status ${res.status}`,
        res.status,
        res.headers.get("x-hr-trace-id") ?? undefined,
        parsed,
      );
    }
    if (!res.body) {
      throw new HyperRouterError("Hyper Router response missing body", res.status, undefined);
    }
    return { stream: res.body, headers: res.headers };
  } finally {
    // Timeout still applies to the response start; once we hand the stream to
    // the caller, they own the abort lifecycle.
    clearTimeout(timeoutId);
  }
}

export async function postChatCompletions(
  config: HttpClientConfig,
  body: ChatCompletionsRequest,
  traceId: string,
  signal?: AbortSignal,
): Promise<{ response: ChatCompletionsResponse; headers: Headers }> {
  const url = `${config.baseUrl}/chat/completions`;
  const ctl = new AbortController();
  const timeoutId = setTimeout(() => ctl.abort(), config.timeoutMs);
  // Combine the outer signal with our timeout-driven controller.
  const combinedSignal = signal
    ? mergeSignals(signal, ctl.signal)
    : ctl.signal;

  try {
    const res = await config.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "X-HR-Trace-Id": traceId,
        "User-Agent": "@hyperrouter/agent",
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
      throw new HyperRouterError(
        `Hyper Router request failed with status ${res.status}`,
        res.status,
        res.headers.get("x-hr-trace-id") ?? undefined,
        parsed,
      );
    }

    const json = (await res.json()) as ChatCompletionsResponse;
    return { response: json, headers: res.headers };
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface BalanceResponse {
  balance: number;
  totalToppedUp: number;
  totalUsed: number;
  scope?: "personal" | "org";
  orgId?: number;
}

/**
 * Fetch the caller's credit balance from Hyper Router. Used by the
 * `budgetExhausted()` stop condition. Cached briefly in the agent loop so
 * we don't hammer the endpoint on every step.
 */
export async function getBalance(
  config: HttpClientConfig,
  signal?: AbortSignal,
): Promise<BalanceResponse> {
  const url = `${config.baseUrl}/credits/balance`;
  const ctl = new AbortController();
  const timeoutId = setTimeout(() => ctl.abort(), Math.min(config.timeoutMs, 10_000));
  const combinedSignal = signal ? mergeSignals(signal, ctl.signal) : ctl.signal;
  try {
    const res = await config.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "User-Agent": "@hyperrouter/agent",
      },
      signal: combinedSignal,
    });
    if (!res.ok) {
      throw new HyperRouterError(
        `Hyper Router /credits/balance failed: ${res.status}`,
        res.status,
        res.headers.get("x-hr-trace-id") ?? undefined,
      );
    }
    return (await res.json()) as BalanceResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctl = new AbortController();
  a.addEventListener("abort", () => ctl.abort(a.reason), { once: true });
  b.addEventListener("abort", () => ctl.abort(b.reason), { once: true });
  return ctl.signal;
}
