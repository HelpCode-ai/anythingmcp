/**
 * RFC 5322 / MIME message builder for the REST engine's `__mime` body marker.
 *
 * Some mail APIs take a whole e-mail rather than fields: Gmail's
 * `messages.send` and `drafts.create` want `{ "raw": "<base64url RFC 5322
 * message>" }`. A tool opts in by putting a marker where that string belongs:
 *
 *   "bodyMapping": {
 *     "raw": { "__mime": { "to": "$to", "subject": "$subject", "text": "$body" } },
 *     "threadId": "$thread_id"
 *   }
 *
 * The engine resolves the marker's fields like any other bodyMapping value,
 * builds the message here and puts the encoded result in place of the marker.
 * A bodyMapping without the marker never reaches this file.
 *
 * Node built-ins only (Buffer, crypto): a new dependency is a Docker image risk.
 */
import { randomBytes } from 'node:crypto';

/** Fields a `__mime` block may carry. Anything else is a configuration error. */
export const MIME_SPEC_KEYS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'subjectPrefix',
  'text',
  'html',
  'inReplyTo',
  'references',
]);

/** How the built message is placed in the body (`__encoding` on the marker). */
export type MimeOutputEncoding = 'base64url' | 'base64' | 'none';
export const MIME_OUTPUT_ENCODINGS: ReadonlySet<string> = new Set(['base64url', 'base64', 'none']);

/** Text plus HTML body above this is refused rather than sent. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** RFC 2047: an encoded-word is at most 75 characters. */
const MAX_ENCODED_WORD = 75;
/** RFC 2047: a header line that carries encoded-words is at most 76 characters. */
const MAX_LINE = 76;
/** RFC 5322 hard limit, used to decide when an ASCII value must be encoded instead. */
const MAX_ASCII_TOKEN = 900;
const CRLF = '\r\n';

export class MimeBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MimeBuildError';
  }
}

export interface MimeBuildOptions {
  /** Fixed multipart boundary (tests). Random otherwise. */
  boundary?: string;
}

/* ------------------------------------------------------------------ */
/*  Header safety                                                      */
/* ------------------------------------------------------------------ */

/**
 * Header values come from the model. A CR or LF would end the header and let
 * the caller write headers (or a body) of its own, so it is refused, not
 * stripped: a subject with a line break is a mistake worth seeing.
 */
function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new MimeBuildError(`${field} must be a single line: line breaks are not allowed in a mail header.`);
  }
  // Other C0 controls (and DEL) have no business in a header either. Tab is
  // whitespace and allowed.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) {
    throw new MimeBuildError(`${field} contains a control character, which is not allowed in a mail header.`);
  }
}

function asText(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new MimeBuildError(`${field} must be a string.`);
}

function isAscii(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(text);
}

/* ------------------------------------------------------------------ */
/*  RFC 2047 encoded-words                                             */
/* ------------------------------------------------------------------ */

/** Largest number of UTF-8 bytes whose B-encoding fits an encoded-word of `maxLen`. */
function bytesForWord(maxLen: number): number {
  const payload = maxLen - '=?UTF-8?B?'.length - '?='.length;
  return Math.floor(payload / 4) * 3;
}

/**
 * Encode `text` as RFC 2047 encoded-words (UTF-8, B encoding). Words never
 * split a character (RFC 2047 section 5), the first is at most `firstMax`
 * characters so it fits on the header's first line, the rest at most 75.
 */
export function encodeWords(text: string, firstMax = MAX_ENCODED_WORD, restMax = MAX_ENCODED_WORD): string[] {
  const words: string[] = [];
  // A word must fit at least one 4-byte character (20 characters).
  let budget = bytesForWord(firstMax >= 20 ? firstMax : restMax);
  let chunk: Buffer[] = [];
  let size = 0;
  const flush = () => {
    if (size === 0) return;
    words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString('base64')}?=`);
    chunk = [];
    size = 0;
    budget = bytesForWord(restMax);
  };
  for (const char of text) {
    const bytes = Buffer.from(char, 'utf8');
    if (size + bytes.length > budget) flush();
    chunk.push(bytes);
    size += bytes.length;
  }
  flush();
  return words;
}

/**
 * Join tokens with single spaces into `Name: value`, folding (CRLF + space)
 * between tokens so lines stay within 76 characters where the tokens allow.
 * Never folds before an empty token, which would leave a whitespace-only line.
 */
export function foldHeader(name: string, tokens: string[], limit = MAX_LINE): string {
  let line = `${name}:`;
  const lines: string[] = [];
  let first = true;
  for (const token of tokens) {
    const candidate = `${line} ${token}`;
    if (!first && token !== '' && candidate.length > limit) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line = candidate;
    }
    first = false;
  }
  lines.push(line);
  return lines.join(CRLF);
}

/** Tokens for an unstructured value (Subject): plain words, or encoded-words. */
function unstructuredTokens(headerName: string, value: string): string[] {
  const words = value.split(' ');
  const mustEncode =
    !isAscii(value) || value.includes('=?') || words.some((w) => w.length > MAX_ASCII_TOKEN);
  if (!mustEncode) return words;
  return encodeWords(value, MAX_LINE - headerName.length - 2);
}

/* ------------------------------------------------------------------ */
/*  Addresses                                                          */
/* ------------------------------------------------------------------ */

interface ParsedAddress {
  name?: string;
  address: string;
}

/** Split a list on commas or semicolons that are not inside quotes or <…>. */
function splitAddressList(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '\\' && i + 1 < text.length) {
      current += c + text[i + 1];
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    if (!quoted && !angle && (c === ',' || c === ';')) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Loose on purpose: one @, no whitespace, no characters that would end or
// restructure the address in a header. Internationalised addresses pass.
const ADDRESS_RE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+$/;

function parseAddress(field: string, item: string): ParsedAddress {
  let name: string | undefined;
  let address = item;
  const angled = /^(.*?)\s*<([^<>]*)>$/.exec(item);
  if (angled) {
    name = angled[1].trim();
    address = angled[2].trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (!name) name = undefined;
  }
  if (!ADDRESS_RE.test(address) || address.length > 320) {
    const shown = item.length > 100 ? `${item.slice(0, 100)}…` : item;
    throw new MimeBuildError(
      `${field}: "${shown}" is not an e-mail address. Use name@example.com or "Name <name@example.com>".`,
    );
  }
  return { name, address };
}

function parseAddresses(field: string, value: unknown): ParsedAddress[] {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  const parsed: ParsedAddress[] = [];
  for (const item of items) {
    const text = asText(field, item);
    if (text === undefined) continue;
    assertHeaderSafe(field, text);
    for (const part of splitAddressList(text)) parsed.push(parseAddress(field, part));
  }
  return parsed;
}

// RFC 5322 specials: a display name containing one must be a quoted-string.
const SPECIALS_RE = /[()<>[\]:;@\\,."]/;

/** Tokens for a display name: encoded-words, a quoted-string, or plain words. */
function displayNameTokens(name: string, firstMax: number): string[] {
  if (!isAscii(name) || name.includes('=?')) return encodeWords(name, firstMax);
  if (SPECIALS_RE.test(name)) return [`"${name.replace(/(["\\])/g, '\\$1')}"`];
  return name.split(/\s+/).filter(Boolean);
}

function addressHeader(name: string, addresses: ParsedAddress[]): string {
  const tokens: string[] = [];
  addresses.forEach((a, i) => {
    const firstMax = i === 0 ? MAX_LINE - name.length - 2 : MAX_ENCODED_WORD;
    const parts = a.name ? [...displayNameTokens(a.name, firstMax), `<${a.address}>`] : [a.address];
    if (i < addresses.length - 1) parts[parts.length - 1] += ',';
    tokens.push(...parts);
  });
  return foldHeader(name, tokens);
}

/* ------------------------------------------------------------------ */
/*  Message-IDs (In-Reply-To / References)                             */
/* ------------------------------------------------------------------ */

function parseMessageIds(field: string, value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const item of items) {
    const text = asText(field, item);
    if (text === undefined) continue;
    assertHeaderSafe(field, text);
    for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
      const id = raw.startsWith('<') ? raw : `<${raw}>`;
      if (!/^<[^<>\s]+>$/.test(id) || id.length > 998) {
        throw new MimeBuildError(
          `${field}: "${raw.slice(0, 100)}" is not a Message-ID. Pass the Message-ID header value, e.g. <abc123@mail.gmail.com>.`,
        );
      }
      ids.push(id);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/*  Bodies                                                             */
/* ------------------------------------------------------------------ */

/** Base64 of UTF-8 text with CRLF line breaks, wrapped at 76 characters. */
function base64Body(text: string): string {
  const canonical = text.replace(/\r\n|\r|\n/g, CRLF);
  const encoded = Buffer.from(canonical, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join(CRLF);
}

function textPart(subtype: 'plain' | 'html', text: string): string {
  return [
    `Content-Type: text/${subtype}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
  ].join(CRLF);
}

/* ------------------------------------------------------------------ */
/*  Entry points                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build an RFC 5322 message from a resolved `__mime` spec. Throws
 * MimeBuildError with a message the model can act on when a field is unusable.
 */
export function buildMimeMessage(spec: Record<string, unknown>, options: MimeBuildOptions = {}): string {
  for (const key of Object.keys(spec)) {
    if (!MIME_SPEC_KEYS.has(key)) {
      throw new MimeBuildError(
        `__mime has an unknown field "${key}". Allowed: ${[...MIME_SPEC_KEYS].join(', ')}.`,
      );
    }
  }

  const headers: string[] = [];
  const addressFields: Array<[string, string]> = [
    ['from', 'From'],
    ['to', 'To'],
    ['cc', 'Cc'],
    ['bcc', 'Bcc'],
    ['replyTo', 'Reply-To'],
  ];
  for (const [key, header] of addressFields) {
    const list = parseAddresses(key, spec[key]);
    if (list.length > 0) headers.push(addressHeader(header, list));
  }

  let subject = asText('subject', spec.subject);
  if (subject !== undefined) {
    assertHeaderSafe('subject', subject);
    subject = subject.replace(/\t/g, ' ').trim();
    const prefix = asText('subjectPrefix', spec.subjectPrefix);
    if (prefix) {
      assertHeaderSafe('subjectPrefix', prefix);
      // "Re: Offer" stays as it is; "Offer" becomes "Re: Offer".
      if (!subject.toLowerCase().startsWith(prefix.trim().toLowerCase())) {
        subject = `${prefix}${subject}`;
      }
    }
    headers.push(foldHeader('Subject', unstructuredTokens('Subject', subject)));
  }

  const inReplyTo = parseMessageIds('inReplyTo', spec.inReplyTo);
  const references = parseMessageIds('references', spec.references);
  // A reply's References is the parent's References plus the parent's own id.
  for (const id of inReplyTo) if (!references.includes(id)) references.push(id);
  if (inReplyTo.length > 0) headers.push(foldHeader('In-Reply-To', inReplyTo));
  if (references.length > 0) headers.push(foldHeader('References', references));

  headers.push('MIME-Version: 1.0');

  const text = asText('text', spec.text);
  const html = asText('html', spec.html);
  const bodyBytes = Buffer.byteLength(text ?? '', 'utf8') + Buffer.byteLength(html ?? '', 'utf8');
  if (bodyBytes > MAX_BODY_BYTES) {
    throw new MimeBuildError(`The message body is too large (${bodyBytes} bytes, limit ${MAX_BODY_BYTES}).`);
  }

  let body: string;
  if (html !== undefined && text !== undefined) {
    const boundary = options.boundary ?? `amcp_${randomBytes(12).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      textPart('plain', text),
      `--${boundary}`,
      textPart('html', html),
      `--${boundary}--`,
      '',
    ].join(CRLF);
  } else {
    const subtype = html !== undefined ? 'html' : 'plain';
    headers.push(`Content-Type: text/${subtype}; charset=UTF-8`, 'Content-Transfer-Encoding: base64');
    body = `${base64Body(html ?? text ?? '')}${CRLF}`;
  }

  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** Encode a built message for the request body. */
export function encodeMimeOutput(message: string, encoding: MimeOutputEncoding = 'base64url'): string {
  if (encoding === 'none') return message;
  return Buffer.from(message, 'utf8').toString(encoding);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A `{ "__mime": … }` node in a bodyMapping template. */
export function isMimeMarker(value: unknown): value is { __mime: unknown; __encoding?: unknown } {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, '__mime');
}

/** Whether a bodyMapping template contains a `__mime` marker anywhere. */
export function containsMimeMarker(template: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(template)) return template.some((v) => containsMimeMarker(v, depth + 1));
  if (!isPlainObject(template)) return false;
  if (isMimeMarker(template)) return true;
  return Object.values(template).some((v) => containsMimeMarker(v, depth + 1));
}

/**
 * Replace every `__mime` marker of a bodyMapping template with a `$name`
 * reference to a built message, returning the new template and the values to
 * add to the params. The engine then resolves the template as it always does;
 * a whole-string `$name` is returned verbatim, so nothing in the message is
 * read as a placeholder. Only markers written in the tool's own template are
 * expanded: a caller's argument that happens to contain `__mime` is left alone.
 */
export function expandMimeMarkers(
  template: Record<string, unknown>,
  resolve: (value: unknown) => unknown,
  options: MimeBuildOptions = {},
): { template: Record<string, unknown>; values: Record<string, string> } {
  const values: Record<string, string> = {};
  let counter = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    if (isMimeMarker(node)) {
      for (const key of Object.keys(node)) {
        if (key !== '__mime' && key !== '__encoding') {
          throw new MimeBuildError(`A __mime marker takes only "__mime" and "__encoding"; found "${key}".`);
        }
      }
      const encoding = node.__encoding ?? 'base64url';
      if (typeof encoding !== 'string' || !MIME_OUTPUT_ENCODINGS.has(encoding)) {
        throw new MimeBuildError(`__encoding must be one of ${[...MIME_OUTPUT_ENCODINGS].join(', ')}.`);
      }
      if (!isPlainObject(node.__mime)) {
        throw new MimeBuildError('__mime must be an object of message fields (to, subject, text, …).');
      }
      const spec = resolve(node.__mime);
      const message = buildMimeMessage(isPlainObject(spec) ? spec : {}, options);
      const name = `__amcp_mime_${counter++}`;
      values[name] = encodeMimeOutput(message, encoding as MimeOutputEncoding);
      return `$${name}`;
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
  };
  return { template: walk(template) as Record<string, unknown>, values };
}
