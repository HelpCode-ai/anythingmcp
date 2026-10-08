/**
 * Keep what we store about one tool call to a bounded excerpt.
 *
 * tool_invocations used to hold every input and output in full. One tenant's
 * backend reading a large schema tens of thousands of times a day wrote
 * ~2.5 GB of logs a day (Oct 2026), kept for 90 days. The log is for
 * debugging, usage analytics and the knowledge graph, none of which needs the
 * whole response, but the knowledge graph does read field names and values,
 * so the excerpt keeps the JSON *structure*: arrays are cut to their first
 * items, long strings are shortened, deep nesting is collapsed. A marker on
 * the top level says it was cut and how big the original was.
 *
 * Values already under the limit are returned untouched (same reference).
 */

export const TRUNCATION_MARKER = '_amcp_truncated';

export interface BoundOptions {
  /** Serialized size the excerpt aims for, in bytes. */
  maxBytes: number;
}

type Shape = { arrayItems: number; stringChars: number; depth: number };

const SHAPES: Shape[] = [
  { arrayItems: 25, stringChars: 2000, depth: 8 },
  { arrayItems: 10, stringChars: 1000, depth: 6 },
  { arrayItems: 5, stringChars: 400, depth: 5 },
  { arrayItems: 3, stringChars: 200, depth: 4 },
  { arrayItems: 1, stringChars: 100, depth: 3 },
];

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function shrink(value: unknown, shape: Shape, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > shape.stringChars
      ? `${value.slice(0, shape.stringChars)}… [${value.length - shape.stringChars} more chars]`
      : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= shape.depth) {
    return Array.isArray(value) ? `[array of ${value.length}]` : '[object]';
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, shape.arrayItems).map((v) => shrink(v, shape, depth + 1));
    if (value.length > shape.arrayItems) kept.push(`… ${value.length - shape.arrayItems} more items`);
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = shrink(v, shape, depth + 1);
  }
  return out;
}

/**
 * Postgres refuses U+0000 and unpaired UTF-16 surrogates in jsonb ("invalid
 * input syntax for type json"), and the whole invocation row was lost. Vendors
 * send the first; cutting a string in the middle of an emoji (Etsy listing
 * titles) makes the second. JSON.stringify writes both as \u escapes, which
 * is how they are spotted without walking every value.
 */
const UNSTORABLE_ESCAPE = /\\u0000|\\ud[89a-f][0-9a-f]{2}/i;
// U+0000 is the character to find here, not a mistake.
// eslint-disable-next-line no-control-regex
const UNSTORABLE_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function cleanText(s: string): string {
  return s.replace(UNSTORABLE_CHARS, '\ufffd');
}

function storable<T>(value: T, json: string): T {
  if (!UNSTORABLE_ESCAPE.test(json)) return value;
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'string' ? cleanText(v) : v)));
}

/**
 * The value itself when it serializes under `maxBytes`; otherwise a
 * structure-preserving excerpt marked with `_amcp_truncated`.
 */
export function boundPayload<T>(value: T, opts: BoundOptions): T | Record<string, unknown> {
  if (value === undefined || value === null) return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { [TRUNCATION_MARKER]: { reason: 'not serializable' } };
  }
  if (json === undefined) return value;
  const originalBytes = byteLength(json);
  if (originalBytes <= opts.maxBytes) return storable(value, json);

  const marker = { originalBytes };
  for (const shape of SHAPES) {
    const shrunk = shrink(value, shape, 0);
    const wrapped =
      shrunk && typeof shrunk === 'object' && !Array.isArray(shrunk)
        ? { [TRUNCATION_MARKER]: marker, ...(shrunk as Record<string, unknown>) }
        : { [TRUNCATION_MARKER]: marker, value: shrunk };
    const wrappedJson = JSON.stringify(wrapped);
    if (byteLength(wrappedJson) <= opts.maxBytes) return storable(wrapped, wrappedJson);
  }
  // Pathological shapes (thousands of keys): keep a plain text excerpt. The
  // excerpt is itself JSON, so escaping makes it grow once stored: shorten
  // until the whole thing fits.
  let chars = Math.max(0, opts.maxBytes - 200);
  for (;;) {
    const fallback = { [TRUNCATION_MARKER]: marker, excerpt: json.slice(0, chars) };
    const fallbackJson = JSON.stringify(fallback);
    if (chars === 0 || byteLength(fallbackJson) <= opts.maxBytes) return storable(fallback, fallbackJson);
    chars = Math.floor(chars * 0.8);
  }
}

/** Errors are free text; keep the beginning, where the useful part is. */
export function boundText(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined || text === null) return text;
  return cleanText(
    text.length > maxChars ? `${text.slice(0, maxChars)}… [truncated, ${text.length} chars]` : text,
  );
}
