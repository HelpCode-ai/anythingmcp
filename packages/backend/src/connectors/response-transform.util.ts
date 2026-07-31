/**
 * Response transformation — optional, per-tool shaping of an API response
 * before it is handed to the MCP client.
 *
 * Why: upstream endpoints routinely return far more than a tool needs (a Datto
 * RMM device carries up to 300 UDF fields, IPs and remote-control URLs when the
 * tool only wants hostname/site/OS/status). Every one of those bytes is billed
 * to the agent's context window and widens what a third-party model gets to see.
 * This lets the operator declare the exposed data model per tool, separately
 * from the full API response.
 *
 * Design constraints, in priority order:
 *   1. A tool without a transform must behave EXACTLY as before — same object,
 *      same reference. This ships to live customers; the no-op path is the one
 *      that must never regress.
 *   2. A broken mapping must never break a working tool. Errors fall back to the
 *      raw response unless the operator explicitly opted out.
 *   3. No code execution. Templates are data; the JMESPath escape hatch is a
 *      data-only expression language. Untrusted upstream keys and operator
 *      template keys are both filtered for prototype-pollution vectors.
 *   4. Bounded work. Depth, wildcard fan-out and emitted-node caps, so a
 *      pathological response or template cannot pin a worker.
 */
import {
  compile as jmespathCompile,
  search as jmespathSearch,
} from '@jmespath-community/jmespath';
import type { ResponseMapping } from './engines/engine-types';

/* ------------------------------------------------------------------ */
/*  Public contract                                                    */
/* ------------------------------------------------------------------ */

export interface ResponseTransform {
  /**
   * 'select'   — declarative template (default when `select` is present)
   * 'jmespath' — evaluate `expression`
   * 'off'      — explicitly disabled; keeps the config around without applying it
   */
  mode?: 'select' | 'jmespath' | 'off' | string;
  /** Keep only these paths, preserving the original document shape. */
  include?: string[];
  /** Drop these paths from the document. Applied before include/select. */
  exclude?: string[];
  /** Output template: keys are output names, leaves are paths or literals. */
  select?: Record<string, unknown>;
  /** JMESPath expression (mode: 'jmespath'). */
  expression?: string;
  /** On error, return the raw response instead of failing. Default true. */
  fallbackToRaw?: boolean;
  /** Hard cap on the serialized output. 0 / absent = no cap. */
  maxBytes?: number;
}

export interface TransformOutcome {
  /** The value to return to the client. Raw response when `applied` is false. */
  value: unknown;
  /** Whether a transform actually ran and changed the value. */
  applied: boolean;
  /** Human-readable reason the transform did not run. */
  error?: string;
  /** True when the operator asked for errors to surface instead of falling back. */
  fatal?: boolean;
  /** True when `maxBytes` kicked in. */
  truncated?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Limits                                                             */
/* ------------------------------------------------------------------ */

const MAX_EXPRESSION_LENGTH = 4000;
const MAX_TEMPLATE_DEPTH = 10;
const MAX_PATH_TOKENS = 32;
const MAX_OUTPUT_NODES = 50_000;
const MAX_PATHS = 500;

// Same guard as output-schema.util: upstream responses and operator templates
// both feed object keys, so neither may reach Object.prototype.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isSafeKey(k: string): boolean {
  return !DANGEROUS_KEYS.has(k);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

class TransformError extends Error {}

/* ------------------------------------------------------------------ */
/*  Path parsing — hand-written scanner, no backtracking regex          */
/* ------------------------------------------------------------------ */

type PathToken =
  | { kind: 'key'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' };

/**
 * Parse `$.devices[*].deviceType.category`, `devices[0].id`, `a['weird.key']`.
 * A leading `$.` / `$` is optional so paths read the same absolute or relative.
 */
export function parsePath(raw: string): PathToken[] {
  const tokens: PathToken[] = [];
  let i = 0;
  const s = raw.trim();

  if (s.startsWith('$')) {
    i = 1;
    if (s[i] === '.') i++;
  }

  let buffer = '';
  const flushKey = () => {
    if (buffer.length === 0) return;
    if (!isSafeKey(buffer)) {
      throw new TransformError(`Unsafe path segment "${buffer}"`);
    }
    tokens.push({ kind: 'key', name: buffer });
    buffer = '';
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      flushKey();
      i++;
    } else if (c === '[') {
      flushKey();
      const close = s.indexOf(']', i);
      if (close === -1) throw new TransformError(`Unclosed "[" in path "${raw}"`);
      const inner = s.slice(i + 1, close).trim();
      if (inner === '*') {
        tokens.push({ kind: 'wildcard' });
      } else if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        const name = inner.slice(1, -1);
        if (!isSafeKey(name)) {
          throw new TransformError(`Unsafe path segment "${name}"`);
        }
        tokens.push({ kind: 'key', name });
      } else {
        const n = Number(inner);
        if (!Number.isInteger(n)) {
          throw new TransformError(`Invalid array index "${inner}" in path "${raw}"`);
        }
        tokens.push({ kind: 'index', index: n });
      }
      i = close + 1;
    } else {
      buffer += c;
      i++;
    }
    if (tokens.length > MAX_PATH_TOKENS) {
      throw new TransformError(`Path "${raw}" is too deep (max ${MAX_PATH_TOKENS} segments)`);
    }
  }
  flushKey();

  if (tokens.length === 0) {
    throw new TransformError(`Empty path "${raw}"`);
  }
  return tokens;
}

/**
 * Resolve a token path against a value.
 *
 * A wildcard turns the rest of the path into a projection: elements that don't
 * have the remaining path are skipped rather than yielding null, which is what
 * keeps mapped responses small. A missing path resolves to "not found", and the
 * caller omits the key entirely.
 */
function resolveTokens(
  value: unknown,
  tokens: PathToken[],
  i: number,
): { found: boolean; value?: unknown } {
  if (i >= tokens.length) return { found: true, value };
  const token = tokens[i];

  if (token.kind === 'wildcard') {
    const items = Array.isArray(value)
      ? value
      : isPlainObject(value)
        ? Object.values(value)
        : null;
    if (items === null) return { found: false };
    const out: unknown[] = [];
    for (const item of items) {
      const r = resolveTokens(item, tokens, i + 1);
      if (r.found) out.push(r.value);
    }
    return { found: true, value: out };
  }

  if (token.kind === 'index') {
    if (!Array.isArray(value)) return { found: false };
    const idx = token.index < 0 ? value.length + token.index : token.index;
    if (idx < 0 || idx >= value.length) return { found: false };
    return resolveTokens(value[idx], tokens, i + 1);
  }

  if (!isPlainObject(value) || !hasOwn(value, token.name)) return { found: false };
  return resolveTokens(value[token.name], tokens, i + 1);
}

function resolvePath(root: unknown, path: string): { found: boolean; value?: unknown } {
  return resolveTokens(root, parsePath(path), 0);
}

/* ------------------------------------------------------------------ */
/*  include / exclude — shape-preserving pruning                       */
/* ------------------------------------------------------------------ */

function assertPathList(paths: unknown, field: string): string[] {
  if (!Array.isArray(paths)) {
    throw new TransformError(`"${field}" must be an array of paths`);
  }
  if (paths.length > MAX_PATHS) {
    throw new TransformError(`"${field}" has too many entries (max ${MAX_PATHS})`);
  }
  return paths.map((p) => {
    if (typeof p !== 'string' || !p.trim()) {
      throw new TransformError(`"${field}" entries must be non-empty strings`);
    }
    return p;
  });
}

/** Deep-copy `root` keeping only the listed paths, preserving the original shape. */
function pickPaths(root: unknown, paths: string[]): unknown {
  const parsed = paths.map(parsePath);
  const budget = { nodes: 0 };
  let out: unknown = undefined;
  for (const tokens of parsed) {
    out = mergePick(out, root, tokens, 0, budget);
  }
  return out === undefined ? (Array.isArray(root) ? [] : {}) : out;
}

function mergePick(
  acc: unknown,
  value: unknown,
  tokens: PathToken[],
  i: number,
  budget: { nodes: number },
): unknown {
  if (++budget.nodes > MAX_OUTPUT_NODES) {
    throw new TransformError(`Output too large (over ${MAX_OUTPUT_NODES} nodes)`);
  }
  if (i >= tokens.length) return value;

  const token = tokens[i];

  // Array branches rebuild with map rather than an indexed write: it keeps
  // element positions aligned with the source, avoids producing a sparse array
  // (which would serialize as stray nulls), and leaves no computed-property
  // write for a reader — or a static analyzer — to have to reason about.
  if (token.kind === 'wildcard' || token.kind === 'index') {
    if (!Array.isArray(value)) return acc;
    const prev: unknown[] = Array.isArray(acc) ? acc : [];
    if (token.kind === 'index') {
      const idx = token.index < 0 ? value.length + token.index : token.index;
      if (idx < 0 || idx >= value.length) return acc;
      return value.map((el, k) =>
        k === idx ? mergePick(prev[k], el, tokens, i + 1, budget) : prev[k],
      );
    }
    return value.map((el, k) => mergePick(prev[k], el, tokens, i + 1, budget));
  }

  if (!isPlainObject(value) || !hasOwn(value, token.name)) return acc;
  // parsePath already rejected the prototype-pollution key names, and
  // Object.fromEntries never walks the prototype chain.
  const base: Record<string, unknown> = isPlainObject(acc) ? acc : {};
  return Object.fromEntries([
    ...Object.entries(base).filter(([k]) => k !== token.name),
    [token.name, mergePick(base[token.name], value[token.name], tokens, i + 1, budget)],
  ]);
}

/** Deep-copy `root` with the listed paths removed. */
function omitPaths(root: unknown, paths: string[]): unknown {
  let out = root;
  for (const path of paths) {
    out = omitPath(out, parsePath(path), 0, { nodes: 0 });
  }
  return out;
}

function omitPath(
  value: unknown,
  tokens: PathToken[],
  i: number,
  budget: { nodes: number },
): unknown {
  if (++budget.nodes > MAX_OUTPUT_NODES) {
    throw new TransformError(`Response too large to prune (over ${MAX_OUTPUT_NODES} nodes)`);
  }
  const token = tokens[i];
  const isLast = i === tokens.length - 1;

  if (token.kind === 'wildcard') {
    if (Array.isArray(value)) {
      return value.map((el) => omitPath(el, tokens, i + 1, budget));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => isSafeKey(k))
          .map(([k, v]) => [k, omitPath(v, tokens, i + 1, budget)]),
      );
    }
    return value;
  }

  if (token.kind === 'index') {
    if (!Array.isArray(value)) return value;
    const idx = token.index < 0 ? value.length + token.index : token.index;
    if (idx < 0 || idx >= value.length) return value;
    if (isLast) return value.filter((_, k) => k !== idx);
    return value.map((el, k) => (k === idx ? omitPath(el, tokens, i + 1, budget) : el));
  }

  if (!isPlainObject(value)) return value;
  if (isLast) {
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => isSafeKey(k) && k !== token.name),
    );
  }
  if (!hasOwn(value, token.name)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => isSafeKey(k))
      .map(([k, v]) => [k, k === token.name ? omitPath(v, tokens, i + 1, budget) : v]),
  );
}

/* ------------------------------------------------------------------ */
/*  select — declarative output template                               */
/* ------------------------------------------------------------------ */

/**
 * Build the output described by `template`, resolved against `root`.
 *
 * Leaf semantics:
 *   "$.a.b" / "a.b"      → path lookup; the key is omitted when not found
 *   "= literal"          → the static string "literal"
 *   42 / true / null     → passed through as-is
 *   { $from, $select }   → iterate an array, reshaping each element
 *   { ... }              → nested template
 *   [ ... ]              → array of the above
 */
function buildFromTemplate(
  root: unknown,
  template: Record<string, unknown>,
  depth: number,
  budget: { nodes: number },
): Record<string, unknown> {
  if (depth > MAX_TEMPLATE_DEPTH) {
    throw new TransformError(`Template nested too deeply (max ${MAX_TEMPLATE_DEPTH})`);
  }
  const entries: [string, unknown][] = [];
  for (const [key, spec] of Object.entries(template)) {
    if (!isSafeKey(key)) continue;
    const resolved = resolveTemplateValue(root, spec, depth, budget);
    if (resolved.found) entries.push([key, resolved.value]);
  }
  return Object.fromEntries(entries);
}

function resolveTemplateValue(
  root: unknown,
  spec: unknown,
  depth: number,
  budget: { nodes: number },
): { found: boolean; value?: unknown } {
  if (++budget.nodes > MAX_OUTPUT_NODES) {
    throw new TransformError(`Output too large (over ${MAX_OUTPUT_NODES} nodes)`);
  }

  if (typeof spec === 'string') {
    if (spec.startsWith('=')) {
      // "= value" / "=value" — static literal, escape hatch for constants that
      // would otherwise be read as a path.
      const literal = spec.slice(1);
      return { found: true, value: literal.startsWith(' ') ? literal.slice(1) : literal };
    }
    return resolvePath(root, spec);
  }

  if (Array.isArray(spec)) {
    const out: unknown[] = [];
    for (const item of spec) {
      const r = resolveTemplateValue(root, item, depth + 1, budget);
      if (r.found) out.push(r.value);
    }
    return { found: true, value: out };
  }

  if (isPlainObject(spec)) {
    if (hasOwn(spec, '$from')) {
      return resolveIteration(root, spec, depth, budget);
    }
    return { found: true, value: buildFromTemplate(root, spec, depth + 1, budget) };
  }

  // number / boolean / null / undefined → literal
  return { found: spec !== undefined, value: spec };
}

/** `{ $from: "$.devices[*]", $select: { … } }` — reshape every array element. */
function resolveIteration(
  root: unknown,
  spec: Record<string, unknown>,
  depth: number,
  budget: { nodes: number },
): { found: boolean; value?: unknown } {
  const from = spec.$from;
  if (typeof from !== 'string') {
    throw new TransformError('"$from" must be a path string');
  }
  const source = resolvePath(root, from);
  if (!source.found) return { found: false };

  const items = Array.isArray(source.value)
    ? source.value
    : source.value === undefined || source.value === null
      ? []
      : [source.value];

  const limit = typeof spec.$limit === 'number' && spec.$limit > 0 ? spec.$limit : undefined;
  const slice = limit ? items.slice(0, limit) : items;

  const select = spec.$select;
  if (select === undefined) {
    return { found: true, value: slice };
  }
  if (!isPlainObject(select)) {
    throw new TransformError('"$select" must be an object');
  }

  const out = slice.map((item) => buildFromTemplate(item, select, depth + 1, budget));
  return { found: true, value: out };
}

/* ------------------------------------------------------------------ */
/*  Size cap                                                           */
/* ------------------------------------------------------------------ */

function capSize(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const json = safeStringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') <= maxBytes) {
    return { value, truncated: false };
  }

  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let size = 2; // []
    for (const item of value) {
      const itemJson = safeStringify(item) ?? 'null';
      const itemSize = Buffer.byteLength(itemJson, 'utf8') + 1;
      if (size + itemSize > maxBytes) break;
      size += itemSize;
      kept.push(item);
    }
    return {
      value: {
        _truncated: true,
        _note: `Response exceeded maxBytes (${maxBytes}); kept ${kept.length} of ${value.length} items.`,
        items: kept,
      },
      truncated: true,
    };
  }

  return {
    value: {
      _truncated: true,
      _note: `Response exceeded maxBytes (${maxBytes}). Narrow the response mapping or raise maxBytes.`,
      _originalBytes: Buffer.byteLength(json, 'utf8'),
      preview: json.slice(0, maxBytes),
    },
    truncated: true,
  };
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  Entry points                                                       */
/* ------------------------------------------------------------------ */

/** Read the transform config out of a responseMapping, honouring legacy `fields`. */
export function readTransform(
  responseMapping: ResponseMapping | Record<string, unknown> | null | undefined,
): ResponseTransform | null {
  if (!isPlainObject(responseMapping)) return null;

  const raw = responseMapping.transform;
  if (isPlainObject(raw)) {
    const t = raw as ResponseTransform;
    if (t.mode === 'off') return null;
    const hasWork =
      t.select !== undefined ||
      t.expression !== undefined ||
      t.include !== undefined ||
      t.exclude !== undefined;
    return hasWork ? t : null;
  }

  // Legacy shape documented since the first release but never implemented:
  //   responseMapping: { type: "json", fields: ["a", "b.c"] }
  // Treat `fields` as an include list so the documented behaviour finally works.
  if (Array.isArray(responseMapping.fields) && responseMapping.fields.length > 0) {
    return { include: responseMapping.fields as string[] };
  }

  return null;
}

/** True when this tool has a response mapping that would change the output. */
export function hasTransform(
  responseMapping: ResponseMapping | Record<string, unknown> | null | undefined,
): boolean {
  return readTransform(responseMapping) !== null;
}

/**
 * Validate a transform config without running it. Returns an error message, or
 * null when the config is usable. Used at save time so a broken mapping is
 * rejected with a 400 instead of silently degrading at runtime.
 */
export function validateTransform(transform: unknown): string | null {
  if (transform === null || transform === undefined) return null;
  if (!isPlainObject(transform)) return 'transform must be an object';

  const t = transform as ResponseTransform;
  if (t.mode !== undefined && !['select', 'jmespath', 'off'].includes(String(t.mode))) {
    return `Unknown mode "${t.mode}" — expected "select", "jmespath" or "off"`;
  }
  if (t.maxBytes !== undefined && (typeof t.maxBytes !== 'number' || t.maxBytes < 0)) {
    return 'maxBytes must be a non-negative number';
  }
  if (t.fallbackToRaw !== undefined && typeof t.fallbackToRaw !== 'boolean') {
    return 'fallbackToRaw must be a boolean';
  }

  try {
    if (t.include !== undefined) assertPathList(t.include, 'include').forEach(parsePath);
    if (t.exclude !== undefined) assertPathList(t.exclude, 'exclude').forEach(parsePath);
    if (t.select !== undefined) {
      if (!isPlainObject(t.select)) return 'select must be an object';
      validateTemplate(t.select, 0);
    }
    if (t.expression !== undefined) {
      if (typeof t.expression !== 'string' || !t.expression.trim()) {
        return 'expression must be a non-empty string';
      }
      if (t.expression.length > MAX_EXPRESSION_LENGTH) {
        return `expression is too long (max ${MAX_EXPRESSION_LENGTH} characters)`;
      }
      // Parse only. Evaluating against a stand-in document would reject
      // perfectly valid expressions on a type error — `length(products)` is
      // correct but throws against `{}` because `products` resolves to null.
      jmespathCompile(t.expression);
    }
  } catch (err: any) {
    return err?.message ? String(err.message) : 'Invalid transform';
  }

  if (String(t.mode) === 'jmespath' && !t.expression) {
    return 'mode "jmespath" requires an expression';
  }
  return null;
}

function validateTemplate(template: Record<string, unknown>, depth: number): void {
  if (depth > MAX_TEMPLATE_DEPTH) {
    throw new TransformError(`Template nested too deeply (max ${MAX_TEMPLATE_DEPTH})`);
  }
  for (const spec of Object.values(template)) {
    if (typeof spec === 'string') {
      if (!spec.startsWith('=')) parsePath(spec);
    } else if (Array.isArray(spec)) {
      validateTemplate({ ...spec } as Record<string, unknown>, depth + 1);
    } else if (isPlainObject(spec)) {
      if (hasOwn(spec, '$from')) {
        if (typeof spec.$from !== 'string') throw new TransformError('"$from" must be a path string');
        parsePath(spec.$from);
        if (spec.$select !== undefined) {
          if (!isPlainObject(spec.$select)) throw new TransformError('"$select" must be an object');
          validateTemplate(spec.$select, depth + 1);
        }
      } else {
        validateTemplate(spec, depth + 1);
      }
    }
  }
}

/**
 * Apply a tool's response mapping to a raw engine result.
 *
 * Returns the raw value untouched (same reference) when no transform is
 * configured — this is the hot path for every existing tool and must stay a
 * single check.
 */
export function applyResponseTransform(
  raw: unknown,
  responseMapping: ResponseMapping | Record<string, unknown> | null | undefined,
): TransformOutcome {
  const transform = readTransform(responseMapping);
  if (!transform) return { value: raw, applied: false };

  const fallbackToRaw = transform.fallbackToRaw !== false;

  try {
    let work: unknown = raw;

    if (transform.exclude !== undefined) {
      work = omitPaths(work, assertPathList(transform.exclude, 'exclude'));
    }
    if (transform.include !== undefined) {
      work = pickPaths(work, assertPathList(transform.include, 'include'));
    }

    const mode =
      transform.mode ??
      (transform.expression ? 'jmespath' : transform.select ? 'select' : 'passthrough');

    if (mode === 'jmespath') {
      const expression = transform.expression;
      if (typeof expression !== 'string' || !expression.trim()) {
        throw new TransformError('mode "jmespath" requires an expression');
      }
      if (expression.length > MAX_EXPRESSION_LENGTH) {
        throw new TransformError(`expression is too long (max ${MAX_EXPRESSION_LENGTH} characters)`);
      }
      work = jmespathSearch(work as any, expression);
    } else if (transform.select !== undefined) {
      if (!isPlainObject(transform.select)) {
        throw new TransformError('select must be an object');
      }
      work = buildFromTemplate(work, transform.select, 0, { nodes: 0 });
    }

    let truncated = false;
    if (typeof transform.maxBytes === 'number' && transform.maxBytes > 0) {
      const capped = capSize(work, transform.maxBytes);
      work = capped.value;
      truncated = capped.truncated;
    }

    return { value: work, applied: true, truncated };
  } catch (err: any) {
    const message = err?.message ? String(err.message) : 'Response mapping failed';
    return {
      value: raw,
      applied: false,
      error: message,
      fatal: !fallbackToRaw,
    };
  }
}
