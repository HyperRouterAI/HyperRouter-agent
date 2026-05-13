/**
 * Convert user-provided schemas (Zod or plain JSON Schema) into the shape the
 * model API expects. Zod is a peer dependency — we import it lazily so the SDK
 * works without it installed.
 */

export interface SchemaLike<T = unknown> {
  /** Marker: distinguishes a Zod schema from plain JSON Schema. */
  _def?: unknown;
  parse?: (raw: unknown) => T;
}

export function isZodSchema(s: unknown): s is { parse: (raw: unknown) => unknown; _def: unknown } {
  return (
    typeof s === "object" &&
    s !== null &&
    "parse" in s &&
    typeof (s as { parse: unknown }).parse === "function" &&
    "_def" in s
  );
}

/** Convert a Zod schema to a JSON Schema. Lazily imports zod-to-json-schema if needed. */
export async function zodToJsonSchema(schema: { _def: unknown }): Promise<Record<string, unknown>> {
  try {
    // Lazy dynamic import. If `zod-to-json-schema` isn't installed, fall back
    // to a basic placeholder so we don't hard-fail the SDK.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("zod-to-json-schema" as string).catch(() => null);
    if (mod && typeof mod.zodToJsonSchema === "function") {
      return mod.zodToJsonSchema(schema as never) as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  // Minimal fallback: empty object schema. The model will still receive the
  // tool definition; argument validation just won't enforce shape until the
  // user installs zod-to-json-schema.
  return { type: "object", properties: {}, additionalProperties: true };
}

/** Synchronous JSON Schema passthrough — no conversion needed. */
export function jsonSchemaPassthrough(schema: Record<string, unknown>): Record<string, unknown> {
  return schema;
}
