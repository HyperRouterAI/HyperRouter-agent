/** Minimal fetch wrapper for Hyper Router /v1/chat/completions. */

import type { RequestOptions, Message, ToolDefinition } from "./types.js";

export const HYPERROUTER_BASE_URL = "https://api.hyperrouter.ai/v1";

export interface ChatCompletionsRequest {
  model: string | string[];
  messages: Message[];
  tools?: Array<{ type: "function"; function: ToolDefinition }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  /** Extra HR-specific knobs sent in the request body. */
  routing?: unknown;
  byok?: unknown;
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
        res.headers.get("x-hr-request-id") ?? undefined,
        parsed,
      );
    }

    const json = (await res.json()) as ChatCompletionsResponse;
    return { response: json, headers: res.headers };
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
