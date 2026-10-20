/**
 * `responseMapping.images`: opt-in hand-off of base64 images in an API
 * response to the MCP client as image content.
 *
 * Image generation APIs answer with the picture inside the JSON: OpenAI's GPT
 * image models put it in `data[].b64_json`, Gemini's image models in
 * `candidates[].content.parts[].inlineData.data`. Neither offers a URL. As
 * text, a 1024x1024 picture is a megabyte or more of base64 the model cannot
 * look at and the user never sees. With
 *
 *   "responseMapping": { "images": { "paths": ["data[*].b64_json"] } }
 *
 * every string found at those paths is checked, taken out of the JSON and
 * returned next to it as an MCP `image` content block. The JSON keeps a short
 * placeholder in its place (type, size, position), which is also what a client
 * that does not show images reads.
 *
 * Only real images leave as images: the bytes must start like a PNG, JPEG,
 * GIF or WebP file, whatever the API claims. Anything else, and anything over
 * the size or count limits, is replaced by a placeholder that says why, so a
 * misconfigured path can never put megabytes of text into the model's context.
 *
 * A tool without `images` never reaches this file.
 */

/** Default and hard limits. Sizes are decoded bytes. */
const DEFAULT_MAX_IMAGES = 4;
const HARD_MAX_IMAGES = 10;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const HARD_MAX_BYTES = 8 * 1024 * 1024;
/** Across all images of one result, whatever the per-image limit. */
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_PATHS = 10;
const MAX_PATH_TOKENS = 32;

export interface ImagesConfig {
  paths: string[];
  /** Images handed over per result. Default 4, at most 10. */
  maxImages: number;
  /** Decoded bytes per image. Default 4 MiB, at most 8 MiB. */
  maxBytes: number;
}

export interface ExtractedImage {
  /** Standard base64 (padded), as MCP image content expects it. */
  data: string;
  mimeType: string;
  /** Decoded size in bytes. */
  bytes: number;
}

export interface ImagesOutcome {
  /** The response with every image string replaced by a placeholder. */
  value: unknown;
  images: ExtractedImage[];
}

type Token = { kind: 'key'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' };

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/**
 * `data[*].b64_json`, `candidates[*].content.parts[*].inlineData.data`,
 * `$.result.image`. Keys, `[n]` and `[*]` only.
 */
function parsePath(raw: string): Token[] {
  let s = raw.trim();
  if (s.startsWith('$')) s = s.slice(s[1] === '.' ? 2 : 1);
  const tokens: Token[] = [];
  let i = 0;
  let key = '';
  const flush = () => {
    if (!key) return;
    if (UNSAFE_KEYS.has(key)) throw new Error(`images: unsafe path segment "${key}"`);
    tokens.push({ kind: 'key', name: key });
    key = '';
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '.') {
      flush();
      i++;
    } else if (c === '[') {
      flush();
      const close = s.indexOf(']', i);
      if (close === -1) throw new Error(`images: unclosed "[" in path "${raw}"`);
      const inner = s.slice(i + 1, close).trim();
      if (inner === '*') tokens.push({ kind: 'wildcard' });
      else if (/^\d+$/.test(inner)) tokens.push({ kind: 'index', index: Number(inner) });
      else throw new Error(`images: "[${inner}]" in path "${raw}" must be an index or *`);
      i = close + 1;
    } else {
      key += c;
      i++;
    }
    if (tokens.length > MAX_PATH_TOKENS) throw new Error(`images: path "${raw}" is too deep`);
  }
  flush();
  if (tokens.length === 0) throw new Error(`images: empty path "${raw}"`);
  return tokens;
}

/**
 * Validate `responseMapping.images`: a path, a list of paths, or
 * `{ paths, maxImages?, maxBytes? }`. Returns an error message or null.
 */
export function validateImages(images: unknown): string | null {
  if (images === undefined || images === null) return null;
  const paths =
    typeof images === 'string'
      ? [images]
      : Array.isArray(images)
        ? images
        : isPlainObject(images)
          ? images.paths
          : undefined;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    return `images needs 1 to ${MAX_PATHS} paths`;
  }
  for (const p of paths) {
    if (typeof p !== 'string') return 'images.paths must be strings';
    try {
      parsePath(p);
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (isPlainObject(images)) {
    for (const key of Object.keys(images)) {
      if (!['paths', 'maxImages', 'maxBytes'].includes(key)) return `images has an unknown option "${key}"`;
    }
    const limits: Array<[string, number]> = [
      ['maxImages', HARD_MAX_IMAGES],
      ['maxBytes', HARD_MAX_BYTES],
    ];
    for (const [key, max] of limits) {
      const v = images[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > max)) {
        return `images.${key} must be an integer from 1 to ${max}`;
      }
    }
  }
  return null;
}

/** The images config of a responseMapping, or null when it has none. Throws when invalid. */
export function readImages(responseMapping: unknown): ImagesConfig | null {
  if (!isPlainObject(responseMapping)) return null;
  const images = responseMapping.images;
  if (images === undefined || images === null) return null;
  const error = validateImages(images);
  if (error) throw new Error(error);
  const options = isPlainObject(images) ? images : {};
  return {
    paths: typeof images === 'string' ? [images] : Array.isArray(images) ? (images as string[]) : (options.paths as string[]),
    maxImages: (options.maxImages as number | undefined) ?? DEFAULT_MAX_IMAGES,
    maxBytes: (options.maxBytes as number | undefined) ?? DEFAULT_MAX_BYTES,
  };
}

/* ------------------------------------------------------------------ */
/*  Bytes                                                              */
/* ------------------------------------------------------------------ */

/** Any character outside the base64 alphabet. A single-character class never backtracks, so it is safe on multi-megabyte strings. */
const NOT_BASE64 = /[^A-Za-z0-9+/]/;
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[\w.-]+)*;base64,/i;

/** Standard, padded base64 of a base64 or base64url string; null when it is neither. */
function normalizeBase64(text: string): string | null {
  let s = text.replace(DATA_URL, '');
  if (s.length < 16) return null;
  if (/[-_]/.test(s)) s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 1) return null;
  if (pad > 0 && !s.endsWith('=')) s += '='.repeat(4 - pad);
  if (s.length % 4 !== 0) return null;
  // Up to two '=' of padding at the end, base64 alphabet before them. Checked
  // without an anchored `+` regex: on a 7 MB image V8 overflows its stack
  // backtracking through one.
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 61 /* = */) end--;
  if (end === 0 || s.length - end > 2) return null;
  return NOT_BASE64.test(s.slice(0, end)) ? null : s;
}

function decodedLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/** The image type from the first bytes, or null when they are not a supported image. */
function sniffMimeType(b64: string): string | null {
  const head = Buffer.from(b64.slice(0, 16), 'base64');
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/* ------------------------------------------------------------------ */
/*  Extraction                                                         */
/* ------------------------------------------------------------------ */

/**
 * Take the images at the configured paths out of `raw`. Copy-on-write: only
 * the objects on the way to a replaced string are copied, the rest (and `raw`
 * itself) is shared and never mutated.
 */
export function extractResponseImages(raw: unknown, config: ImagesConfig): ImagesOutcome {
  const images: ExtractedImage[] = [];
  let total = 0;

  const replace = (leaf: unknown): unknown => {
    if (typeof leaf !== 'string' || leaf.length === 0) return leaf;
    const b64 = normalizeBase64(leaf);
    const mimeType = b64 ? sniffMimeType(b64) : null;
    if (!b64 || !mimeType) {
      return `[omitted: ${formatBytes(leaf.length)} of data that is not a PNG, JPEG, GIF or WebP image]`;
    }
    const bytes = decodedLength(b64);
    if (bytes > config.maxBytes) {
      return `[image omitted: ${mimeType}, ${formatBytes(bytes)}, above the ${formatBytes(config.maxBytes)} limit for images returned to the client. Ask for a smaller size or a compressed format.]`;
    }
    if (images.length >= config.maxImages) {
      return `[image omitted: only the first ${config.maxImages} images of a result are returned]`;
    }
    if (total + bytes > MAX_TOTAL_BYTES) {
      return `[image omitted: the images of this result exceed ${formatBytes(MAX_TOTAL_BYTES)} together]`;
    }
    total += bytes;
    images.push({ data: b64, mimeType, bytes });
    return `[image ${images.length}: ${mimeType}, ${formatBytes(bytes)}, attached to this result as an image]`;
  };

  let value = raw;
  for (const path of config.paths) {
    value = replaceAt(value, parsePath(path), 0, replace);
  }
  return { value, images };
}

function replaceAt(node: unknown, tokens: Token[], i: number, fn: (leaf: unknown) => unknown): unknown {
  if (i === tokens.length) return fn(node);
  const token = tokens[i];
  if (token.kind === 'key') {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, token.name)) return node;
    const child = node[token.name];
    const next = replaceAt(child, tokens, i + 1, fn);
    return next === child ? node : { ...node, [token.name]: next };
  }
  if (token.kind === 'index') {
    if (!Array.isArray(node) || token.index >= node.length) return node;
    const child = node[token.index];
    const next = replaceAt(child, tokens, i + 1, fn);
    if (next === child) return node;
    const copy = node.slice();
    copy[token.index] = next;
    return copy;
  }
  if (Array.isArray(node)) {
    let copy: unknown[] | null = null;
    node.forEach((child, k) => {
      const next = replaceAt(child, tokens, i + 1, fn);
      if (next !== child) {
        copy ??= node.slice();
        copy[k] = next;
      }
    });
    return copy ?? node;
  }
  if (isPlainObject(node)) {
    let copy: Record<string, unknown> | null = null;
    for (const [k, child] of Object.entries(node)) {
      if (UNSAFE_KEYS.has(k)) continue;
      const next = replaceAt(child, tokens, i + 1, fn);
      if (next !== child) {
        copy ??= { ...node };
        copy[k] = next;
      }
    }
    return copy ?? node;
  }
  return node;
}
