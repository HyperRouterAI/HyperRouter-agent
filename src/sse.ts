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

/**
 * Parse an SSE byte stream into chunk objects. Yields one ChatChunk per
 * `data:` line until `data: [DONE]` is seen or the stream ends.
 *
 * Resilient to:
 *   - Multi-line events split across network packets (buffers until `\n\n`)
 *   - Comments (`:`-prefixed lines) — ignored
 *   - Multiple `data:` lines per event (concatenated per the SSE spec)
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
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
          const parsed = parseEvent(buffer);
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
        const parsed = parseEvent(rawEvent);
        if (parsed === DONE_SENTINEL) return;
        if (parsed !== null) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const DONE_SENTINEL = Symbol("done");

function parseEvent(rawEvent: string): ChatChunk | typeof DONE_SENTINEL | null {
  // Collect all `data:` lines for this event.
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // empty or comment
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
