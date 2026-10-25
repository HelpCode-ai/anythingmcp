/**
 * Binary bodies in REST responses: files, images, PDFs.
 *
 * axios decodes every response body as UTF-8 text. A file download (Telegram's
 * `https://api.telegram.org/file/bot<token>/<file_path>`, an invoice PDF, a
 * product photo) came back as a string of replacement characters, which is
 * neither the file nor anything a model can use (support #108, October 2026).
 *
 * The REST engine therefore receives the raw bytes and decides here:
 *  - a body that is text (a text-like content type, or valid UTF-8 under no
 *    content type at all) is decoded and parsed exactly as axios did before —
 *    JSON when it parses, the string otherwise;
 *  - anything else becomes a `BinaryBody`: content type, size, file name and
 *    the bytes as base64.
 *
 * A `BinaryBody` is plain JSON, so it survives the response cache. When the
 * result is rendered for the MCP client (`renderBinaryBody`) a PNG, JPEG, GIF
 * or WebP leaves as image content, any other file as an embedded resource
 * (`blob`), and the text part describes the file. Within limits: a file over
 * them is described and not sent. The audit log and the dashboard's tool
 * test never store the bytes (`withoutBinaryData`).
 */

/** Marks the object the engine hands back for a binary body. */
export const BINARY_MARKER = '__amcpBinary';

export interface BinaryBody {
  [BINARY_MARKER]: 1;
  contentType: string;
  /** Size in bytes. */
  bytes: number;
  /** From Content-Disposition when the server named the file. */
  filename?: string;
  /** Standard, padded base64 of the whole body. */
  base64: string;
}

/** Bytes handed to the client per file by default, and at most. */
export const DEFAULT_MAX_BINARY_BYTES = 4 * 1024 * 1024;
export const HARD_MAX_BINARY_BYTES = 10 * 1024 * 1024;

/** Content types whose body is text whatever bytes it holds. */
const TEXT_TYPE = /^(text\/|image\/svg\+xml\b|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|x-www-form-urlencoded|graphql|x-ndjson|ld\+json|problem\+json|csv|yaml|x-yaml)\b)/i;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const lenientUtf8 = new TextDecoder('utf-8');

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function header(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return '';
  const h = headers as Record<string, unknown> & { get?: (n: string) => unknown };
  const v = typeof h.get === 'function' ? h.get(name) : h[name] ?? h[name.toLowerCase()];
  return v == null ? '' : String(v);
}

/** The file name a Content-Disposition header gives, if any. */
export function dispositionFilename(disposition: string): string | undefined {
  if (!disposition) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(disposition);
  if (star) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')));
    } catch {
      /* fall through to the plain parameter */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
  const name = plain ? (plain[2] ?? plain[1]).trim() : '';
  return name ? sanitizeFilename(name) : undefined;
}

function sanitizeFilename(name: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const base = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g, '').trim();
  return base ? base.slice(0, 200) : undefined;
}

/** Text, parsed the way axios' default transform parses it. */
function parseText(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The response body as the engine hands it on: parsed JSON or text as before,
 * or a `BinaryBody` for a file. Used as the REST engine's `transformResponse`
 * with `responseType: 'arraybuffer'`, so it sees every response, errors too.
 */
export function decodeResponseBody(data: unknown, headers?: unknown): unknown {
  const buf = toBuffer(data);
  if (!buf) return typeof data === 'string' ? parseText(data) : data;
  if (buf.length === 0) return '';

  const contentType = header(headers, 'content-type').split(';')[0].trim().toLowerCase();
  if (TEXT_TYPE.test(contentType)) return parseText(lenientUtf8.decode(buf));

  // No content type, or a generic one: text when the bytes are valid UTF-8
  // without control characters a text body would not have.
  if (!contentType || contentType === 'application/octet-stream') {
    try {
      const text = utf8.decode(buf);
      // eslint-disable-next-line no-control-regex
      if (!/[\u0000-\u0008\u000e-\u001a]/.test(text)) return parseText(text);
    } catch {
      /* not UTF-8: a file */
    }
  }

  return {
    [BINARY_MARKER]: 1,
    contentType: contentType || 'application/octet-stream',
    bytes: buf.length,
    ...(dispositionFilename(header(headers, 'content-disposition'))
      ? { filename: dispositionFilename(header(headers, 'content-disposition')) }
      : {}),
    base64: buf.toString('base64'),
  } satisfies BinaryBody;
}

export function isBinaryBody(value: unknown): value is BinaryBody {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)[BINARY_MARKER] === 1 &&
    typeof (value as Record<string, unknown>).base64 === 'string'
  );
}

/** The image type from the first bytes, or null when they are not a supported image. */
function sniffImage(head: Buffer): string | null {
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

/** `responseMapping.binary`: how a binary body is handed over. */
export interface BinaryConfig {
  /**
   * `auto` (default): images as image content, other files as an embedded
   * resource. `base64`: the base64 goes into the JSON text instead, for a
   * workflow that passes the file on to another tool.
   */
  as: 'auto' | 'base64';
  /** Bytes per file. Default 4 MiB, at most 10 MiB. */
  maxBytes: number;
}

export function readBinaryConfig(responseMapping: unknown): BinaryConfig {
  const raw =
    responseMapping && typeof responseMapping === 'object'
      ? (responseMapping as Record<string, unknown>).binary
      : undefined;
  const cfg = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const max = typeof cfg.maxBytes === 'number' && cfg.maxBytes > 0 ? cfg.maxBytes : DEFAULT_MAX_BINARY_BYTES;
  return {
    as: cfg.as === 'base64' ? 'base64' : 'auto',
    maxBytes: Math.min(Math.floor(max), HARD_MAX_BINARY_BYTES),
  };
}

/** `responseMapping.binary` problems a save should refuse; null when fine. */
export function validateBinaryConfig(binary: unknown): string | null {
  if (binary === undefined || binary === null) return null;
  if (typeof binary !== 'object' || Array.isArray(binary)) return 'binary must be an object';
  const b = binary as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (key !== 'as' && key !== 'maxBytes') return `binary: unknown key "${key}"`;
  }
  if (b.as !== undefined && b.as !== 'auto' && b.as !== 'base64') return 'binary.as must be "auto" or "base64"';
  if (
    b.maxBytes !== undefined &&
    (typeof b.maxBytes !== 'number' || !Number.isInteger(b.maxBytes) || b.maxBytes <= 0 || b.maxBytes > HARD_MAX_BINARY_BYTES)
  ) {
    return `binary.maxBytes must be a whole number of bytes between 1 and ${HARD_MAX_BINARY_BYTES}`;
  }
  return null;
}

export type BinaryContent =
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

export interface RenderedBinary {
  /** What the text part of the result says about the file. */
  value: Record<string, unknown>;
  content: BinaryContent[];
}

/**
 * The text and the extra content blocks for a binary body. The bytes are
 * never put in the text unless the tool asked for `binary.as: "base64"`.
 */
export function renderBinaryBody(body: BinaryBody, config: BinaryConfig, uriHint = 'response'): RenderedBinary {
  const describe: Record<string, unknown> = {
    file: {
      contentType: body.contentType,
      bytes: body.bytes,
      size: formatBytes(body.bytes),
      ...(body.filename ? { filename: body.filename } : {}),
    },
  };
  if (body.bytes > config.maxBytes) {
    describe.note = `The file is ${formatBytes(body.bytes)}, over this tool's limit of ${formatBytes(config.maxBytes)}, so it is not attached.`;
    return { value: describe, content: [] };
  }
  if (config.as === 'base64') {
    (describe.file as Record<string, unknown>).base64 = body.base64;
    return { value: describe, content: [] };
  }
  const image = sniffImage(Buffer.from(body.base64.slice(0, 16), 'base64'));
  if (image) {
    describe.note = 'The image is attached to this result.';
    return { value: describe, content: [{ type: 'image', data: body.base64, mimeType: image }] };
  }
  const name = body.filename ?? uriHint.replace(/[^\w.-]+/g, '-');
  describe.note = 'The file is attached to this result as an embedded resource.';
  return {
    value: describe,
    content: [
      {
        type: 'resource',
        resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType: body.contentType, blob: body.base64 },
      },
    ],
  };
}

/**
 * `value` with every binary body's bytes replaced by a short note, for the
 * audit log, the knowledge graph and the dashboard's tool test.
 */
export function withoutBinaryData<T>(value: T): T {
  if (!isBinaryBody(value)) return value;
  return { ...value, base64: `[${formatBytes(value.bytes)} of binary data not stored]` } as T;
}
