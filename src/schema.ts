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

/**
 * Convert a Zod schema to a JSON Schema. `zod-to-json-schema` is a direct
 * dependency (not optional) since 0.1.3 — empty-schema silent fallback led
 * to model receiving `{ properties: {} }` for every tool, returning empty
 * arg objects, and downstream Zod validation failing with confusing
 * "expected string, received undefined" errors. If the import ever fails
 * (broken install, registry mirror, etc.) we log loudly and STILL return
 * an empty placeholder so the SDK doesn't hard-crash, but it's now a
 * top-of-stderr warning instead of a silent footgun.
 */
let warnedMissingConverter = false;

export async function zodToJsonSchema(schema: { _def: unknown }): Promise<Record<string, unknown>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("zod-to-json-schema" as string).catch(() => null);
    if (mod && typeof mod.zodToJsonSchema === "function") {
      return mod.zodToJsonSchema(schema as never) as Record<string, unknown>;
    }
  } catch {
    /* fall through to warning */
  }
  if (!warnedMissingConverter) {
    warnedMissingConverter = true;
    console.error(
      "[@hyperrouter/agent] zod-to-json-schema not resolvable — tool input " +
      "schemas will be empty placeholders, causing models to receive no " +
      "argument hints and Zod validation to fail downstream. " +
      "Reinstall the SDK or run `npm install zod-to-json-schema@^3` directly.",
    );
  }
  return { type: "object", properties: {}, additionalProperties: true };
}

/** Synchronous JSON Schema passthrough — no conversion needed. */
export function jsonSchemaPassthrough(schema: Record<string, unknown>): Record<string, unknown> {
  return schema;
}
