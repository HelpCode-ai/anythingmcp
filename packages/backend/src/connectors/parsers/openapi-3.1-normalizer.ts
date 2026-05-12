/**
 * Translate OpenAPI 3.1-only constructs into their 3.0 equivalents in place
 * so the rest of the import pipeline (which was written against 3.0) can
 * consume them.
 *
 * 3.1 adopts JSON Schema 2020-12 and removes some 3.0 specialisms; the
 * differences that bite us in practice are:
 *
 *   - `type: ["string", "null"]`           →  `type: "string"` + `nullable: true`
 *   - `anyOf: [{...}, {type: "null"}]`     →  unwrap and set `nullable: true`
 *   - `oneOf` with a `type: "null"` member →  unwrap and set `nullable: true`
 *   - `const: "x"`                          →  `enum: ["x"]`
 *   - `examples: [...]` (plural array)      →  `example: examples[0]` (singular)
 *   - `exclusiveMinimum: <number>`          →  `minimum: <number>` + `exclusiveMinimum: true`
 *   - `exclusiveMaximum: <number>`          →  `maximum: <number>` + `exclusiveMaximum: true`
 *
 * Everything else (3.1 webhooks, 3.1 jsonSchemaDialect, info.summary, etc.)
 * is left alone — it either survives `extractTools` untouched or is metadata
 * that doesn't affect tool generation.
 *
 * The function mutates the input. It returns the same reference so callers
 * can chain. Use only on documents declared as openapi: 3.1.x — running it
 * on a 3.0 spec is a no-op but the conditional in OpenApiParser.parse keeps
 * us honest.
 */
export function normalizeOpenApi31(spec: unknown): unknown {
  walk(spec);
  // swagger-parser 10.x hard-rejects any openapi value other than 3.0.0–3.0.3
  // (even from dereference()). Once the structural rewrites above are done the
  // document is functionally 3.0-compatible, so we relabel it so the parser
  // accepts it. This is the single point that hides the version difference
  // from the downstream pipeline.
  if (spec && typeof spec === 'object') {
    const obj = spec as Record<string, unknown>;
    if (typeof obj.openapi === 'string' && obj.openapi.startsWith('3.1')) {
      obj.openapi = '3.0.3';
    }
    // 3.1 added info.summary; 3.0 forbids it. We don't currently call the
    // schema validator on 3.1 specs (we use dereference()), so this is a
    // defensive strip: it keeps the relabeled document safe if any future
    // codepath does call validate().
    const info = obj.info;
    if (info && typeof info === 'object' && 'summary' in (info as Record<string, unknown>)) {
      delete (info as Record<string, unknown>).summary;
    }
  }
  return spec;
}

function walk(node: unknown): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }

  const obj = node as Record<string, unknown>;

  // 1. type: ["string","null"] → type: "string", nullable: true
  if (Array.isArray(obj.type)) {
    const types = obj.type as unknown[];
    const nonNull = types.filter((t) => t !== 'null');
    if (nonNull.length === 1 && types.includes('null')) {
      obj.type = nonNull[0];
      obj.nullable = true;
    } else if (types.includes('null')) {
      // Multi-type with null (e.g. ["string","number","null"]) — drop "null"
      // and mark nullable. 3.0 has no union types so we keep the first
      // non-null type; this is lossy but better than rejecting the spec.
      obj.type = nonNull[0] ?? 'string';
      obj.nullable = true;
    }
  }

  // 2. anyOf / oneOf with a {type: "null"} member → unwrap + nullable
  for (const key of ['anyOf', 'oneOf'] as const) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      const nullIdx = arr.findIndex(
        (s) => s && typeof s === 'object' && (s as { type?: unknown }).type === 'null',
      );
      if (nullIdx >= 0) {
        const remaining = arr.filter((_, i) => i !== nullIdx);
        if (remaining.length === 1) {
          // Promote the single remaining schema onto this node and flag nullable.
          const promoted = remaining[0] as Record<string, unknown>;
          for (const [k, v] of Object.entries(promoted)) {
            if (!(k in obj)) obj[k] = v;
          }
          delete obj[key];
          obj.nullable = true;
        } else if (remaining.length > 1) {
          obj[key] = remaining;
          obj.nullable = true;
        }
      }
    }
  }

  // 3. const: "x" → enum: ["x"]
  if ('const' in obj && !('enum' in obj)) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  // 4. examples: [...] → example: examples[0]
  // Skip when `examples` is the OpenAPI components-level map of named examples
  // (a sibling of `schemas`/`parameters`), which is an object, not an array.
  if (Array.isArray(obj.examples) && obj.examples.length > 0 && !('example' in obj)) {
    obj.example = obj.examples[0];
    delete obj.examples;
  }

  // 5. exclusiveMinimum / exclusiveMaximum as numbers (3.1) → boolean form (3.0)
  if (typeof obj.exclusiveMinimum === 'number') {
    obj.minimum = obj.exclusiveMinimum;
    obj.exclusiveMinimum = true;
  }
  if (typeof obj.exclusiveMaximum === 'number') {
    obj.maximum = obj.exclusiveMaximum;
    obj.exclusiveMaximum = true;
  }

  // Recurse into children
  for (const value of Object.values(obj)) walk(value);
}
