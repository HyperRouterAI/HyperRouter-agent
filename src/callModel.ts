/**
 * Public entry point. Runs the streaming agent loop once on first await,
 * pushes events into a Channel, and exposes them via lazy getters.
 */

import { runAgentLoopStreaming, type StreamingLoopResult } from "./streaming-loop.js";
import { resolveConfig } from "./http-client.js";
import { Channel } from "./channel.js";
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
  const channel = new Channel<StreamItem>();

  // Kick off the loop on the first await of any getter. Multiple awaits share
  // the same promise; the channel is broadcast so multiple streams can iterate.
  let runPromise: Promise<StreamingLoopResult> | null = null;
  const ensureRun = (): Promise<StreamingLoopResult> => {
    if (!runPromise) {
      runPromise = runAgentLoopStreaming({ config, input, traceId, channel })
        .then((res) => {
          channel.close();
          return res;
        })
        .catch((err) => {
          channel.push({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
          channel.close(err);
          throw err;
        });
    }
    return runPromise;
  };

  return {
    async getText() {
      const { finalMessage } = await ensureRun();
      if (typeof finalMessage.content === "string") return finalMessage.content;
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
      const sub = channel.subscribe();
      // Start the run lazily — subscribers don't trigger it on their own.
      void ensureRun();
      return (async function* () {
        for await (const item of sub) {
          if (item.type === "text-delta") yield item.delta;
        }
      })();
    },
    getItemsStream(): AsyncIterable<StreamItem> {
      const sub = channel.subscribe();
      void ensureRun();
      return sub;
    },
    getToolCallsStream(): AsyncIterable<ToolCallRequest> {
      const sub = channel.subscribe();
      void ensureRun();
      return (async function* () {
        for await (const item of sub) {
          if (item.type === "tool-call") yield item.toolCall;
        }
      })();
    },
  };
}
