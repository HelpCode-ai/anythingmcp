/**
 * `responseMapping.decode` — opt-in decoding of mail API responses into text a
 * model can read.
 *
 * Gmail returns a message as a MIME tree (`payload.parts[]`) whose bodies are
 * base64url-encoded (`body.data`). Handed over as is, the model gets an opaque
 * blob, often several times larger than the text it needs. With
 *
 *   "responseMapping": { "decode": "gmail-message" }
 *
 * every message in the response (a message, a thread's `messages[]`, a
 * draft's `message`) is replaced by its headers, its text (text/plain
 * preferred, tag-stripped text/html otherwise) and a list of attachments.
 * Anything that is not such a message (list results, `format=minimal`,
 * `format=raw`) passes through untouched.
 *
 * Bounded like the other transforms: the text of one message and of the whole
 * response are capped, the MIME walk has a depth and part limit, and HTML is
 * scanned without backtracking regular expressions.
 */

export const DECODE_TYPES: ReadonlySet<string> = new Set(['gmail-message']);

export interface DecodeConfig {
  type: 'gmail-message';
  /** Characters of text kept per message. Default 20,000. */
  maxTextChars: number;
  /** Characters of text kept across the whole response. Default 100,000. */
  maxTotalChars: number;
}

const DEFAULT_MAX_TEXT_CHARS = 20_000;
const DEFAULT_MAX_TOTAL_CHARS = 100_000;
const MAX_PART_DEPTH = 20;
const MAX_PARTS = 500;
const MAX_MESSAGES = 500;
/** HTML longer than this is cut before it is scanned. */
const MAX_HTML_SCAN = 2 * 1024 * 1024;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

/**
 * Validate `responseMapping.decode`. Accepts the type as a string or
 * `{ type, maxTextChars?, maxTotalChars? }`. Returns an error message or null.
 */
export function validateDecode(decode: unknown): string | null {
  if (decode === undefined || decode === null) return null;
  const type = typeof decode === 'string' ? decode : isPlainObject(decode) ? decode.type : undefined;
  if (typeof type !== 'string' || !DECODE_TYPES.has(type)) {
    return `decode must be one of: ${[...DECODE_TYPES].join(', ')}`;
  }
  if (isPlainObject(decode)) {
    for (const key of ['maxTextChars', 'maxTotalChars']) {
      const v = decode[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
        return `decode.${key} must be a positive integer`;
      }
    }
    for (const key of Object.keys(decode)) {
      if (!['type', 'maxTextChars', 'maxTotalChars'].includes(key)) {
        return `decode has an unknown option "${key}"`;
      }
    }
  }
  return null;
}

/** The decode config of a responseMapping, or null when it has none. */
export function readDecode(responseMapping: unknown): DecodeConfig | null {
  if (!isPlainObject(responseMapping)) return null;
  const decode = responseMapping.decode;
  if (decode === undefined || decode === null) return null;
  const error = validateDecode(decode);
  if (error) throw new Error(error);
  const options = isPlainObject(decode) ? decode : {};
  return {
    type: 'gmail-message',
    maxTextChars: (options.maxTextChars as number | undefined) ?? DEFAULT_MAX_TEXT_CHARS,
    maxTotalChars: (options.maxTotalChars as number | undefined) ?? DEFAULT_MAX_TOTAL_CHARS,
  };
}

/* ------------------------------------------------------------------ */
/*  Bytes and charsets                                                 */
/* ------------------------------------------------------------------ */

/** base64url (or plain base64), padding optional, into bytes. */
export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An unknown or unsupported label: UTF-8 is right far more often than not.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** RFC 2047 encoded-words in a header value (Gmail usually decodes these already). */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  // Whitespace between two adjacent encoded-words is not part of the text.
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (match, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                String.fromCharCode(parseInt(hex, 16)),
              ),
              'latin1',
            );
      return decodeBytes(bytes, charset.split('*')[0]);
    } catch {
      return match;
    }
  });
}

/* ------------------------------------------------------------------ */
/*  HTML to text                                                       */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set([
  'br', 'p', 'div', 'tr', 'li', 'ul', 'ol', 'table', 'blockquote', 'section', 'article',
  'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'pre',
]);
const PARAGRAPH_END_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table']);
/** Stand-in for a paragraph break until whitespace is tidied (U+2029). */
const PARAGRAPH = '\u2029';
const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'head', 'title', 'template']);
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', euro: '€', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à',
  ograve: 'ò', ugrave: 'ù', igrave: 'ì', Eacute: 'É', ccedil: 'ç', ntilde: 'ñ',
};

function decodeEntities(text: string): string {
  // One pass, so "&amp;lt;" becomes "&lt;" and is not decoded twice.
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

/**
 * Readable text from HTML: tags dropped, script/style/head content dropped,
 * block elements as line breaks, entities decoded, whitespace tidied. Not a
 * sanitizer: the result is plain text for a model, never rendered as HTML.
 */
export function htmlToText(html: string): string {
  const input = html.length > MAX_HTML_SCAN ? html.slice(0, MAX_HTML_SCAN) : html;
  const lower = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt);
    if (lower.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) {
      i = input.length;
      break;
    }
    const nameMatch = /^<\/?\s*([a-zA-Z0-9]+)/.exec(input.slice(lt, Math.min(gt + 1, lt + 40)));
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    const closing = input[lt + 1] === '/';
    i = gt + 1;
    if (!closing && SKIP_CONTENT_TAGS.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      if (end === -1) {
        i = input.length;
      } else {
        const close = input.indexOf('>', end);
        i = close === -1 ? input.length : close + 1;
      }
      continue;
    }
    if (PARAGRAPH_END_TAGS.has(name) && closing) out += PARAGRAPH;
    else if (BLOCK_TAGS.has(name)) out += '\n';
    else if (name === 'td' || name === 'th') out += ' ';
  }
  return decodeEntities(out)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    // Every block boundary is one line break; the end of a paragraph or a
    // heading leaves one blank line.
    .replace(/ *\n[ \n]*/g, '\n')
    .replace(/\n*\u2029[\n\u2029 ]*/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/*  Gmail messages                                                     */
/* ------------------------------------------------------------------ */

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

function headerValue(part: GmailPart, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const headers = Array.isArray(part.headers) ? part.headers : [];
  const h = headers.find((x) => typeof x?.name === 'string' && x.name.toLowerCase() === wanted);
  return typeof h?.value === 'string' ? decodeEncodedWords(h.value) : undefined;
}

function charsetOf(part: GmailPart): string | undefined {
  const ct = headerValue(part, 'Content-Type') ?? '';
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
  return m ? m[1] : undefined;
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  if (part.body?.attachmentId && !part.body?.data) return true;
  return /^\s*attachment/i.test(headerValue(part, 'Content-Disposition') ?? '');
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: Array<Record<string, unknown>>;
}

function walkParts(node: unknown, depth: number, acc: Collected, count: { parts: number }): void {
  if (depth > MAX_PART_DEPTH || ++count.parts > MAX_PARTS || !isPlainObject(node)) return;
  const part = node as GmailPart;
  const mime = String(part.mimeType ?? '').toLowerCase();
  if (Array.isArray(part.parts) && part.parts.length > 0) {
    for (const child of part.parts) walkParts(child, depth + 1, acc, count);
    return;
  }
  if (isAttachment(part)) {
    acc.attachments.push(
      Object.fromEntries(
        Object.entries({
          partId: part.partId,
          filename: part.filename || undefined,
          mimeType: part.mimeType,
          size: part.body?.size,
          attachmentId: part.body?.attachmentId,
        }).filter(([, v]) => v !== undefined && v !== ''),
      ),
    );
    return;
  }
  const data = part.body?.data;
  if (typeof data !== 'string' || data === '') return;
  if (mime === 'text/plain') acc.plain.push(decodeBytes(decodeBase64Url(data), charsetOf(part)));
  else if (mime === 'text/html') acc.html.push(decodeBytes(decodeBase64Url(data), charsetOf(part)));
}

const HEADER_FIELDS: Array<[string, string]> = [
  ['from', 'From'],
  ['to', 'To'],
  ['cc', 'Cc'],
  ['bcc', 'Bcc'],
  ['replyTo', 'Reply-To'],
  ['subject', 'Subject'],
  ['date', 'Date'],
  ['messageId', 'Message-ID'],
  ['inReplyTo', 'In-Reply-To'],
  ['references', 'References'],
];

function isGmailMessage(value: unknown): value is Record<string, unknown> & { payload: GmailPart } {
  return isPlainObject(value) && isPlainObject(value.payload);
}

function decodeMessage(message: Record<string, unknown> & { payload: GmailPart }, config: DecodeConfig, budget: { left: number }) {
  const payload = message.payload;
  const out: Record<string, unknown> = {};
  for (const key of ['id', 'threadId', 'labelIds', 'snippet', 'internalDate', 'historyId']) {
    if (message[key] !== undefined) out[key] = message[key];
  }
  for (const [key, header] of HEADER_FIELDS) {
    const v = headerValue(payload, header);
    if (v !== undefined) out[key] = v;
  }

  const acc: Collected = { plain: [], html: [], attachments: [] };
  walkParts(payload, 0, acc, { parts: 0 });

  let text: string | undefined;
  if (acc.plain.length > 0) {
    text = acc.plain.join('\n\n').replace(/\r\n?/g, '\n').trim();
    out.textFormat = 'text/plain';
  } else if (acc.html.length > 0) {
    text = acc.html.map(htmlToText).join('\n\n');
    out.textFormat = 'text/html (converted to text)';
  }
  if (text !== undefined) {
    const limit = Math.max(0, Math.min(config.maxTextChars, budget.left));
    if (text.length > limit) {
      out.text = text.slice(0, limit);
      out.textTruncated = true;
      out.textLength = text.length;
    } else {
      out.text = text;
    }
    budget.left -= (out.text as string).length;
  }
  if (acc.attachments.length > 0) out.attachments = acc.attachments;
  return out;
}

/**
 * Apply `decode` to a response. Gmail message objects are replaced by their
 * decoded form wherever the API puts them: the body itself, `messages[]`
 * (threads), `message` (drafts). Everything else is returned unchanged.
 */
export function applyDecode(raw: unknown, config: DecodeConfig): unknown {
  const budget = { left: config.maxTotalChars };
  if (isGmailMessage(raw)) return decodeMessage(raw, config, budget);
  if (!isPlainObject(raw)) return raw;

  let changed = false;
  const out: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.messages)) {
    const messages = raw.messages.slice(0, MAX_MESSAGES);
    if (messages.some(isGmailMessage)) {
      out.messages = messages.map((m) => (isGmailMessage(m) ? decodeMessage(m, config, budget) : m));
      if (raw.messages.length > MAX_MESSAGES) out.messagesOmitted = raw.messages.length - MAX_MESSAGES;
      changed = true;
    }
  }
  if (isGmailMessage(raw.message)) {
    out.message = decodeMessage(raw.message, config, budget);
    changed = true;
  }
  return changed ? out : raw;
}
