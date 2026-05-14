/**
 * Minimal SSE parser for the OpenAI-compatible /v1/chat/completions stream.
 *
 * Lines look like:
 *
 *   data: {"id":"...","choices":[{"delta":{"content":"Hel"}}]}
 *   data: {"id":"...","choices":[{"delta":{"content":"lo"}}]}
 *   data: [DONE]
 *
 * We yield each `data:` JSON payload as an object. `[DONE]` terminates.
 */

export interface ChatChunk {
  id?: string;
  /** Model that actually served the request — OpenAI-compatible streams
   * include this in every chunk. For requests routed via hyperrouter/auto
   * (or backend-internal fallback) this is the resolved slug, NOT what
   * the client originally asked for. */
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface ParseSseOptions {
  /**
   * Called for every SSE comment line (lines starting with `:`).
   * Hyper Router uses these to surface out-of-band metadata like
   * cost (`: cost=0.00009300`) that doesn't fit cleanly into the
   * OpenAI chunk schema. The argument is the comment body without
   * the leading colon.
   */
  onComment?: (text: string) => void;
}

/**
 * Parse an SSE byte stream into chunk objects. Yields one ChatChunk per
 * `data:` line until `data: [DONE]` is seen or the stream ends.
 *
 * Resilient to:
 *   - Multi-line events split across network packets (buffers until `\n\n`)
 *   - Multiple `data:` lines per event (concatenated per the SSE spec)
 *
 * SSE comment lines (`:`-prefixed) are surfaced via `options.onComment`
 * if provided; otherwise dropped silently.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options?: ParseSseOptions,
): AsyncIterable<ChatChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush any final partial event.
        if (buffer.trim()) {
          const parsed = parseEvent(buffer, options);
          if (parsed !== null && parsed !== DONE_SENTINEL) yield parsed;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      // Split on blank lines — SSE event boundary.
      let separatorIdx: number;
      while ((separatorIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIdx);
        buffer = buffer.slice(separatorIdx + 2);
        const parsed = parseEvent(rawEvent, options);
        if (parsed === DONE_SENTINEL) return;
        if (parsed !== null) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const DONE_SENTINEL = Symbol("done");

function parseEvent(rawEvent: string, options?: ParseSseOptions): ChatChunk | typeof DONE_SENTINEL | null {
  // Collect all `data:` lines for this event; surface `:`-comment lines.
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(":")) {
      if (options?.onComment) options.onComment(line.slice(1).trim());
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // ignore `event:` / `id:` / `retry:` — OpenAI-compat streams don't use them
  }
  if (dataLines.length === 0) return null;

  const data = dataLines.join("\n");
  if (data === "[DONE]") return DONE_SENTINEL;

  try {
    return JSON.parse(data) as ChatChunk;
  } catch {
    // Skip malformed chunks rather than crash the stream.
    return null;
  }
}

/**
 * Extract a `cost=NUMBER` value from an SSE comment body, if present.
 * Returns the cost as a USD number, or undefined.
 */
export function parseCostComment(commentText: string): number | undefined {
  const m = commentText.match(/cost=([0-9.eE+-]+)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Extract the text delta from a chunk, if present. */
export function chunkText(chunk: ChatChunk): string {
  return chunk.choices?.[0]?.delta?.content ?? "";
}

/** Extract tool-call deltas (OpenAI emits incremental name/arguments per chunk). */
export function chunkToolCallDeltas(chunk: ChatChunk) {
  return chunk.choices?.[0]?.delta?.tool_calls ?? [];
}

/** Extract finish_reason if present (only on the final chunk, usually). */
export function chunkFinishReason(chunk: ChatChunk): string | undefined {
  return chunk.choices?.[0]?.finish_reason ?? undefined;
}
