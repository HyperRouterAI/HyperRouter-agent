/**
 * Agent telemetry — pushes step traces to Hyper Router's
 * /v1/agent/telemetry endpoint so the user can see step trees,
 * cost breakdowns, and fallback events in the HR Dashboard.
 *
 * The SDK ships this on by default. Disable per-call with
 * `observability: { disabled: true }` or globally via
 * env HYPERROUTER_OBSERVABILITY=off.
 *
 * Failure is non-fatal — telemetry is best-effort, never blocks
 * the agent loop on a network hiccup.
 */

import type { HttpClientConfig } from "./http-client.js";
import type { StepResult } from "./types.js";

export interface ObservabilityConfig {
  /** Disable telemetry uploads (defaults to false). */
  disabled?: boolean;
  /** Trace id, propagated to every step. Auto-generated if absent. */
  traceId?: string;
  /** User-supplied session id (groups multiple traces into one user session). */
  sessionId?: string;
  /** Override the telemetry endpoint URL (default: <baseUrl>/agent/telemetry). */
  endpoint?: string;
}

export function isEnabled(config: ObservabilityConfig | undefined): boolean {
  if (config?.disabled === true) return false;
  const envValue = (process.env.HYPERROUTER_OBSERVABILITY ?? "").toLowerCase();
  if (envValue === "off" || envValue === "false" || envValue === "0") return false;
  return true;
}

export interface TracePayload {
  type: "trace_start";
  traceId: string;
  sessionId?: string;
  timestamp: number;
  model: string | string[];
  messageCount: number;
  toolCount: number;
}

export interface StepPayload {
  type: "step";
  traceId: string;
  sessionId?: string;
  stepIndex: number;
  timestamp: number;
  finishReason: string;
  usage: StepResult["usage"];
  routing?: StepResult["routing"];
  toolCallCount: number;
  toolCallNames: string[];
  errorCount: number;
  /** Truncated message preview — first 500 chars. Full content stays client-side. */
  messagePreview?: string;
}

export interface TraceEndPayload {
  type: "trace_end";
  traceId: string;
  sessionId?: string;
  timestamp: number;
  totalSteps: number;
  totalUsage: StepResult["usage"];
  stopReason: string;
}

type Payload = TracePayload | StepPayload | TraceEndPayload;

/** Best-effort fire-and-forget telemetry POST. Never throws. */
export async function postTelemetry(
  config: HttpClientConfig,
  observability: ObservabilityConfig,
  payload: Payload,
): Promise<void> {
  if (!isEnabled(observability)) return;
  const url = observability.endpoint ?? `${config.baseUrl}/agent/telemetry`;
  try {
    await config.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "User-Agent": "@hyperrouter/agent",
      },
      body: JSON.stringify(payload),
      // Don't keep the process alive on a slow telemetry call.
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Swallow. Telemetry must never break the agent.
  }
}

export function buildTracePayload(
  observability: ObservabilityConfig,
  model: string | string[],
  messageCount: number,
  toolCount: number,
): TracePayload {
  return {
    type: "trace_start",
    traceId: observability.traceId!,
    sessionId: observability.sessionId,
    timestamp: Date.now(),
    model,
    messageCount,
    toolCount,
  };
}

export function buildStepPayload(
  observability: ObservabilityConfig,
  step: StepResult,
  messagePreview: string,
): StepPayload {
  return {
    type: "step",
    traceId: observability.traceId!,
    sessionId: observability.sessionId,
    stepIndex: step.index,
    timestamp: Date.now(),
    finishReason: step.finishReason,
    usage: step.usage,
    routing: step.routing,
    toolCallCount: step.toolCalls.length,
    toolCallNames: step.toolCalls.map((tc) => tc.request.function.name),
    errorCount: step.toolCalls.filter((tc) => tc.error).length,
    messagePreview: messagePreview.slice(0, 500),
  };
}

export function buildTraceEndPayload(
  observability: ObservabilityConfig,
  totalSteps: number,
  totalUsage: StepResult["usage"],
  stopReason: string,
): TraceEndPayload {
  return {
    type: "trace_end",
    traceId: observability.traceId!,
    sessionId: observability.sessionId,
    timestamp: Date.now(),
    totalSteps,
    totalUsage,
    stopReason,
  };
}
