/**
 * Infer a JSON Schema from a sample response, and build a *permissive* Zod shape
 * to serve it as an MCP tool's outputSchema.
 *
 * Design note: the MCP SDK validates a tool's `structuredContent` against its
 * outputSchema and FAILS the call on mismatch. To never break a working tool we
 * store the rich inferred schema (for our UI / future) but serve a permissive
 * shape (top-level keys as `any`) so validation can't fail, while still giving
 * the client the response's field names.
 */
import { z } from 'zod';

type JsonSchema = Record<string, any>;

const MAX_DEPTH = 6;

// The inferred schema is built from upstream API responses (untrusted), whose
// keys become property names. To avoid prototype-pollution / property-injection
// we (a) drop dangerous keys and (b) build every object via Object.fromEntries
// rather than a computed-property write (`obj[key] = …`), so there is no
// injectable assignment sink at all.
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
function safeKey(k: string): boolean {
  return !DANGEROUS_KEYS.includes(k);
}

/** Infer a JSON Schema from a sample value (objects/arrays/primitives). */
export function inferJsonSchema(value: unknown, depth = 0): JsonSchema | null {
  if (value === null || value === undefined) return null;
  if (depth > MAX_DEPTH) return {};

  if (Array.isArray(value)) {
    // Merge the first few items into one item schema.
    let items: JsonSchema | null = null;
    for (const el of value.slice(0, 10)) {
      const s = inferJsonSchema(el, depth + 1);
      items = items ? mergeSchema(items, s) : s;
    }
    return { type: 'array', items: items ?? {} };
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => safeKey(k))
      .map(([k, v]) => [k, inferJsonSchema(v, depth + 1) ?? {}] as const);
    return { type: 'object', properties: Object.fromEntries(entries), additionalProperties: true };
  }

  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

/** Shallow merge of two inferred schemas (for refining across samples). */
export function mergeSchema(a: JsonSchema | null, b: JsonSchema | null): JsonSchema {
  if (!a) return b ?? {};
  if (!b) return a;
  if (a.type === 'object' && b.type === 'object') {
    const merged = new Map<string, JsonSchema>(
      Object.entries((a.properties ?? {}) as Record<string, JsonSchema>).filter(([k]) => safeKey(k)),
    );
    for (const [k, v] of Object.entries((b.properties ?? {}) as Record<string, JsonSchema>)) {
      if (!safeKey(k)) continue;
      const existing = merged.get(k);
      merged.set(k, existing ? mergeSchema(existing, v) : v);
    }
    return { type: 'object', properties: Object.fromEntries(merged), additionalProperties: true };
  }
  if (a.type === 'array' && b.type === 'array') {
    return { type: 'array', items: mergeSchema(a.items ?? null, b.items ?? null) };
  }
  return a.type === b.type ? a : {}; // type drift → loosen to "any"
}

/**
 * Permissive Zod raw shape for serving: one optional `z.any()` per top-level
 * property of an object schema. Returns null when the schema isn't an object
 * with properties (we only serve outputSchema for object-shaped responses).
 *
 * `.optional()` is required, not decoration. In Zod 4 a bare `z.any()` object
 * key is required, so a response that omits a key the sample had fails the
 * MCP SDK's structuredContent validation ("expected nonoptional, received
 * undefined") and the whole call errors. APIs omit keys all the time: Google
 * Search Console leaves out `rows` when a query matches nothing, which broke
 * every empty or past-the-end gsc_query_search_analytics call.
 */
export function outputSchemaToZodShape(
  schema: unknown,
): Record<string, z.ZodTypeAny> | null {
  const s = schema as JsonSchema | null;
  if (!s || s.type !== 'object' || !s.properties || typeof s.properties !== 'object') {
    return null;
  }
  const entries = Object.keys(s.properties)
    .filter(safeKey)
    .map((k) => [k, z.any().optional()] as const);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}
