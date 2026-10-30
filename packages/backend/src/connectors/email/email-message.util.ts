import type { MessageAddressObject, MessageStructureObject, SearchObject } from 'imapflow';
import { EmailConnectorError } from './email-settings';

/**
 * Pure helpers of the email engine: tool parameters to IMAP criteria, the
 * MIME structure of a message to its body parts and attachments, truncation
 * and reply headers. No network, so every rule here is unit-tested directly.
 */

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_UIDS = 100;
export const DEFAULT_BODY_CHARS = 20_000;
export const MAX_BODY_CHARS = 100_000;
export const DEFAULT_ATTACHMENT_CHARS = 50_000;
export const MAX_ATTACHMENT_CHARS = 200_000;
export const MAX_RECIPIENTS = 50;
export const SNIPPET_CHARS = 200;

const MAX_CRITERION_CHARS = 500;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

function str(field: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new EmailConnectorError(`${field} must be text.`, 'invalid_input');
  }
  const out = String(value).trim();
  if (!out) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00]/.test(out)) {
    throw new EmailConnectorError(`${field} must be a single line.`, 'invalid_input');
  }
  if (out.length > MAX_CRITERION_CHARS) {
    throw new EmailConnectorError(`${field} is longer than ${MAX_CRITERION_CHARS} characters.`, 'invalid_input');
  }
  return out;
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return undefined;
}

/** A calendar date (YYYY-MM-DD, or an ISO timestamp whose date part counts). */
export function parseDay(field: string, value: unknown): Date | undefined {
  const raw = str(field, value);
  if (!raw) return undefined;
  const m = DATE_RE.exec(raw);
  const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !date || Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(m[3])) {
    throw new EmailConnectorError(`${field} must be a date as YYYY-MM-DD, e.g. 2026-10-01.`, 'invalid_input');
  }
  return date;
}

/**
 * The search tool's parameters as an imapflow query. IMAP SINCE / BEFORE
 * compare the date the server received the message, by day.
 */
export function buildSearchQuery(params: Record<string, unknown>): SearchObject {
  const query: SearchObject = {};
  const from = str('from', params.from);
  const to = str('to', params.to);
  const subject = str('subject', params.subject);
  const text = str('text', params.text);
  if (from) query.from = from;
  if (to) query.to = to;
  if (subject) query.subject = subject;
  if (text) query.text = text;
  const since = parseDay('since', params.since);
  const before = parseDay('before', params.before);
  if (since && before && since.getTime() >= before.getTime()) {
    throw new EmailConnectorError('since must be earlier than before.', 'invalid_input');
  }
  if (since) query.since = since;
  if (before) query.before = before;
  if (flag(params.unread_only) === true) query.seen = false;
  if (flag(params.flagged_only) === true) query.flagged = true;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

/** A count parameter, clamped to [1, max]. */
export function clampInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

/** One UID (a positive integer), as a number. */
export function parseUid(field: string, value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new EmailConnectorError(`${field} must be a message UID (a positive whole number) from search_messages.`, 'invalid_input');
  }
  return n;
}

/** UIDs from an array, a single number or a comma list; at most MAX_UIDS, deduplicated. */
export function parseUids(value: unknown): number[] {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(/[\s,]+/).filter(Boolean);
  else if (value === undefined || value === null) items = [];
  else items = [value];
  if (items.length === 0) {
    throw new EmailConnectorError('uids must list at least one message UID.', 'invalid_input');
  }
  const uids = [...new Set(items.map((v) => parseUid('uids', v)))];
  if (uids.length > MAX_UIDS) {
    throw new EmailConnectorError(`At most ${MAX_UIDS} messages per call; split the list.`, 'invalid_input');
  }
  return uids;
}

/** A folder parameter: INBOX by default, single line, no wildcards (LIST patterns). */
export function parseFolder(field: string, value: unknown, fallback = 'INBOX'): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new EmailConnectorError(`${field} must be a folder path.`, 'invalid_input');
  const out = value.trim();
  if (!out) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(out) || out.length > 255) {
    throw new EmailConnectorError(`${field} is not a usable folder path.`, 'invalid_input');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Message structure                                                  */
/* ------------------------------------------------------------------ */

export interface BodyPart {
  /** IMAP section, e.g. "1", "1.2". */
  part: string;
  type: string;
  /** Encoded size the server reports. */
  size?: number;
}

export interface AttachmentInfo {
  /** 1-based, in the order the parts appear. */
  index: number;
  part: string;
  filename: string;
  contentType: string;
  /** Size of the decoded file, estimated from the encoded size. */
  approxBytes?: number;
  /** Shown inside the body (an embedded image) rather than attached. */
  inline: boolean;
}

export interface MessageParts {
  text?: BodyPart;
  html?: BodyPart;
  attachments: AttachmentInfo[];
}

function filenameOf(node: MessageStructureObject): string | undefined {
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (typeof name !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const base = name.split(/[\\/]/).pop()?.replace(/[\x00-\x1F\x7F]/g, '').trim();
  return base ? base.slice(0, 200) : undefined;
}

function decodedSize(node: MessageStructureObject): number | undefined {
  if (typeof node.size !== 'number') return undefined;
  const enc = (node.encoding ?? '').toLowerCase();
  // Base64 carries 3 bytes in 4 characters, plus line breaks.
  if (enc === 'base64') return Math.floor((node.size * 3) / 4 / 1.013);
  return node.size;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'message/rfc822': 'eml',
  'text/calendar': 'ics',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'text/plain': 'txt',
  'text/html': 'html',
};

/**
 * Walk a BODYSTRUCTURE: the first plain-text and HTML body parts, and every
 * other leaf as an attachment. A forwarded message (message/rfc822) is one
 * attachment, not walked into.
 */
export function analyseStructure(root: MessageStructureObject | undefined): MessageParts {
  const out: MessageParts = { attachments: [] };
  if (!root) return out;
  const visit = (node: MessageStructureObject, partId: string, inAlternative: boolean) => {
    const type = (node.type || 'application/octet-stream').toLowerCase();
    if (type.startsWith('multipart/')) {
      (node.childNodes ?? []).forEach((child, i) =>
        visit(child, child.part ?? (partId ? `${partId}.${i + 1}` : String(i + 1)), type === 'multipart/alternative' || inAlternative),
      );
      return;
    }
    const part = node.part ?? (partId || '1');
    const disposition = (node.disposition ?? '').toLowerCase();
    const filename = filenameOf(node);
    const isBodyCandidate = disposition !== 'attachment' && (!filename || inAlternative);
    if (isBodyCandidate && type === 'text/plain' && !out.text) {
      out.text = { part, type, size: node.size };
      return;
    }
    if (isBodyCandidate && type === 'text/html' && !out.html) {
      out.html = { part, type, size: node.size };
      return;
    }
    // Further text parts without a name (a mailing-list footer) are body
    // fragments, not files anyone would open.
    if (!filename && disposition !== 'attachment' && (type === 'text/plain' || type === 'text/html')) return;
    const ext = EXTENSION_BY_TYPE[type] ?? 'bin';
    out.attachments.push({
      index: out.attachments.length + 1,
      part,
      filename: filename ?? `part-${part}.${ext}`,
      contentType: type,
      approxBytes: decodedSize(node),
      inline: disposition === 'inline' || (!!node.id && disposition !== 'attachment'),
    });
  };
  visit(root, '', false);
  return out;
}

/** Content types returned to the model as text rather than as a file. */
export function isTextualType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    /^application\/(json|xml|[\w.+-]+\+json|[\w.+-]+\+xml|x-yaml|yaml|csv|x-ndjson|ics)$/.test(ct)
  );
}

/* ------------------------------------------------------------------ */
/*  Text                                                               */
/* ------------------------------------------------------------------ */

export interface TruncatedText {
  text: string;
  truncated: boolean;
  totalChars: number;
}

/** Cut text at `max` characters with a marker that says how to get more. */
export function truncateText(text: string, max: number, what = 'body'): TruncatedText {
  const totalChars = text.length;
  if (totalChars <= max) return { text, truncated: false, totalChars };
  return {
    text:
      `${text.slice(0, max)}\n\n[... ${what} truncated: showing ${max} of ${totalChars} characters. ` +
      'Call again with a larger max_chars to read more.]',
    truncated: true,
    totalChars,
  };
}

/** Whitespace collapsed, at most SNIPPET_CHARS. */
export function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

/** "Name <address>" for each envelope address. */
export function formatAddresses(list: MessageAddressObject[] | undefined): string[] {
  return (list ?? [])
    .filter((a) => a && (a.address || a.name))
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? '')));
}

/** "Re: " in front, unless the subject already is a reply (Re:, AW:, SV:, R:, Antw:). */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? '').trim();
  if (/^(re|aw|sv|antw|ref|r)\s*:/i.test(s)) return s;
  return s ? `Re: ${s}` : 'Re:';
}

/** References for a reply: the parent's References plus the parent's Message-ID, deduplicated. */
export function replyReferences(parentReferences: unknown, parentMessageId: string | undefined): string[] {
  const refs: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== 'string') return;
    for (const id of v.match(/<[^<>\s]+>/g) ?? []) if (!refs.includes(id)) refs.push(id);
  };
  if (Array.isArray(parentReferences)) parentReferences.forEach(add);
  else add(parentReferences);
  add(parentMessageId);
  // Mail servers cap header length; keep the root and the most recent ids.
  return refs.length > 20 ? [refs[0], ...refs.slice(-19)] : refs;
}

/** RFC 5322 date with a numeric zone. */
export function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}
