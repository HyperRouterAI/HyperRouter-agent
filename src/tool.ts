/** `tool()` builder — accepts Zod or plain JSON Schema. */

import type { Tool, ToolContext, ToolApproval } from "./types.js";
import { isZodSchema, zodToJsonSchema, jsonSchemaPassthrough } from "./schema.js";

export interface ToolConfig<TInput, TOutput> {
  name: string;
  description: string;
  /**
   * Tool input schema. Accepts either:
   *   - a Zod schema (`z.object({ ... })`), or
   *   - a plain JSON Schema object (`{ type: "object", properties: {...} }`).
   *
   * If you pass a Zod schema, install `zod` and (optionally) `zod-to-json-schema`
   * to get auto-generated parameter schemas the model can see.
   */
  inputSchema:
    | { parse: (raw: unknown) => TInput; _def: unknown }
    | Record<string, unknown>;
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
  onToolCalled?: (input: TInput, ctx: ToolContext) => Promise<ToolApproval> | ToolApproval;
  onResponseReceived?: (input: TInput, output: TOutput, ctx: ToolContext) => void;
}

/**
 * Define an agent tool. Returns a runnable Tool that callModel() can dispatch.
 *
 * Sync (JSON Schema) version returns synchronously. Zod version is async because
 * we lazy-load `zod-to-json-schema`. Both wrap into Promise so the caller can
 * always `await tool({...})` consistently.
 */
export async function tool<TInput, TOutput>(config: ToolConfig<TInput, TOutput>): Promise<Tool<TInput, TOutput>> {
  const parameters = isZodSchema(config.inputSchema)
    ? await zodToJsonSchema(config.inputSchema)
    : jsonSchemaPassthrough(config.inputSchema);

  const parseInput = (rawArgs: string): TInput => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch (e) {
      throw new Error(
        `Tool "${config.name}" got non-JSON arguments from the model: ${(e as Error).message}`,
      );
    }
    if (isZodSchema(config.inputSchema)) {
      return config.inputSchema.parse(parsed) as TInput;
    }
    return parsed as TInput;
  };

  return {
    name: config.name,
    description: config.description,
    parameters,
    parseInput,
    execute: config.execute,
    onToolCalled: config.onToolCalled,
    onResponseReceived: config.onResponseReceived,
  };
}

/** Synchronous variant — only works with plain JSON Schema (no Zod). */
export function toolSync<TInput, TOutput>(
  config: Omit<ToolConfig<TInput, TOutput>, "inputSchema"> & { inputSchema: Record<string, unknown> },
): Tool<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    parameters: jsonSchemaPassthrough(config.inputSchema),
    parseInput: (rawArgs: string) => JSON.parse(rawArgs) as TInput,
    execute: config.execute,
    onToolCalled: config.onToolCalled,
    onResponseReceived: config.onResponseReceived,
  };
}
