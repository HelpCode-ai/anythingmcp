/**
 * `endpointMapping.download`: read a file whose address the API hands back.
 *
 * Some APIs do not return the data itself but a short-lived download link to
 * it: Amazon SP-API reports (`GET /reports/2021-06-30/documents/{id}` answers
 * `{ url, compressionAlgorithm }`), export jobs, and the like. An AI client
 * cannot open that link: it has no HTTP access, and the file is often gzip.
 * With this block the tool makes the API call as usual, then fetches the link
 * on the server, decompresses it, parses delimited text and returns one page
 * of rows.
 *
 * Safety:
 *   - the link is fetched with fetchOutbound: SSRF checks on it and on every
 *     redirect, no connector credentials, a byte cap and a timeout;
 *   - only https, and only hosts the tool lists in `allowedHosts`;
 *   - decompression is capped (`maxOutputLength`), so a gzip bomb stops early;
 *   - at most MAX_LIMIT rows go back per call.
 */
import { promisify } from 'util';
import { gunzip as gunzipCb } from 'zlib';
import { fetchOutbound } from '../../common/outbound-fetch.util';

const gunzip = promisify(gunzipCb);

export interface DownloadFollowConfig {
  /** Path of the link in the API response, e.g. "url" or "payload.url". */
  urlField: string;
  /** Path of a compression marker; the value "GZIP" means gunzip. Gzip magic bytes are detected anyway. */
  compressionField?: string;
  /** 'auto' (default) picks JSON, tab- or comma-separated text from the content. */
  format?: 'auto' | 'tsv' | 'csv' | 'json' | 'text';
  /** Host names the link may point to; a leading dot or a bare domain also matches its subdomains. Required. */
  allowedHosts: string[];
  /** Tool argument references (`$name`) for paging and filtering. */
  offset?: string;
  limit?: string;
  columns?: string;
  filterColumn?: string;
  filterValue?: string;
}

export const DOWNLOAD_DEFAULT_LIMIT = 50;
export const DOWNLOAD_MAX_LIMIT = 500;
/** Compressed bytes fetched. */
export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Bytes after decompression. */
// Parsed rows take several times the text size in memory, so stay well below the heap headroom.
export const DOWNLOAD_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const TEXT_PREVIEW_CHARS = 20_000;

/** Validate the stored block. Returns an error message, or null when usable. */
export function validateDownloadConfig(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'download must be an object';
  const c = raw as Record<string, unknown>;
  if (typeof c.urlField !== 'string' || !c.urlField.trim()) return 'download.urlField is required';
  if (!Array.isArray(c.allowedHosts) || c.allowedHosts.length === 0 || !c.allowedHosts.every((h) => typeof h === 'string' && h.trim())) {
    return 'download.allowedHosts must list at least one host';
  }
  if (c.format !== undefined && !['auto', 'tsv', 'csv', 'json', 'text'].includes(String(c.format))) {
    return 'download.format must be auto, tsv, csv, json or text';
  }
  return null;
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function arg(params: Record<string, unknown>, ref: string | undefined): unknown {
  if (!ref || !ref.startsWith('$')) return undefined;
  const v = params[ref.slice(1)];
  return v === '' || v === null ? undefined : v;
}

function toList(v: unknown): string[] {
  if (v === undefined) return [];
  const items = Array.isArray(v) ? v : String(v).split(',');
  return items.map((s) => String(s).trim()).filter(Boolean);
}

function toInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((raw) => {
    const a = raw.trim().toLowerCase().replace(/^\./, '');
    return h === a || h.endsWith(`.${a}`);
  });
}

/** Decode with the charset from Content-Type; Amazon writes some reports as Cp1252. */
export function decodeText(buf: Buffer, contentType: string | undefined): string {
  const m = /charset=([^;\s]+)/i.exec(contentType ?? '');
  let charset = (m?.[1] ?? 'utf-8').replace(/["']/g, '').toLowerCase();
  if (charset === 'cp1252') charset = 'windows-1252';
  let text: string;
  try {
    text = new TextDecoder(charset).decode(buf);
  } catch {
    text = buf.toString('utf8');
  }
  // Drop a byte order mark (U+FEFF) so the first column name stays clean.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split delimited text into records. Tabs: Amazon flat files, no quoting.
 * Commas: RFC 4180 quoting ("" inside quotes, line breaks in quoted fields).
 */
export function parseDelimited(text: string, delimiter: '\t' | ','): string[][] {
  const out: string[][] = [];
  if (delimiter === '\t') {
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      out.push(line.split('\t'));
    }
    return out;
  }
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field.length === 0) {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') out.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') out.push(row);
  }
  return out;
}

function detectFormat(text: string): 'json' | 'tsv' | 'csv' | 'text' {
  const head = text.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
  const tabs = firstLine.split('\t').length - 1;
  const commas = firstLine.split(',').length - 1;
  if (tabs > 0 && tabs >= commas) return 'tsv';
  if (commas > 0) return 'csv';
  return 'text';
}

/** Page and filter parsed rows. The first record is the header. */
export function pageRows(
  records: string[][],
  opts: { offset: number; limit: number; columns: string[]; filterColumn?: string; filterValues: string[] },
): Record<string, unknown> {
  const header = (records[0] ?? []).map((h) => h.trim());
  const body = records.slice(1);
  const lower = header.map((h) => h.toLowerCase());
  const idx = (name: string) => lower.indexOf(name.trim().toLowerCase());

  let rows = body;
  if (opts.filterColumn && opts.filterValues.length > 0) {
    const col = idx(opts.filterColumn);
    if (col < 0) {
      throw new Error(
        `Column "${opts.filterColumn}" is not in this file. Columns: ${header.join(', ')}`,
      );
    }
    const wanted = new Set(opts.filterValues.map((v) => v.toLowerCase()));
    rows = body.filter((r) => wanted.has(String(r[col] ?? '').trim().toLowerCase()));
  }

  let picked = header.map((_, i) => i);
  if (opts.columns.length > 0) {
    const missing = opts.columns.filter((c) => idx(c) < 0);
    if (missing.length > 0) {
      throw new Error(`Columns not in this file: ${missing.join(', ')}. Columns: ${header.join(', ')}`);
    }
    picked = opts.columns.map(idx);
  }

  const page = rows.slice(opts.offset, opts.offset + opts.limit).map((r) => {
    const o: Record<string, string> = {};
    for (const i of picked) o[header[i] || `column_${i + 1}`] = r[i] ?? '';
    return o;
  });
  const next = opts.offset + page.length;
  return {
    columns: header,
    totalRows: body.length,
    matchedRows: rows.length,
    offset: opts.offset,
    returned: page.length,
    nextOffset: next < rows.length ? next : null,
    rows: page,
  };
}

/**
 * Fetch the link named in `apiBody`, then decode, parse and page it.
 * `fetch` is injectable for tests.
 */
export async function followDownload(
  apiBody: unknown,
  config: DownloadFollowConfig,
  params: Record<string, unknown>,
  fetch: typeof fetchOutbound = fetchOutbound,
): Promise<Record<string, unknown>> {
  const invalid = validateDownloadConfig(config);
  if (invalid) throw new Error(`This tool's download settings are invalid: ${invalid}.`);

  const link = readPath(apiBody, config.urlField);
  if (typeof link !== 'string' || !link) {
    throw new Error(`The API response has no download link at "${config.urlField}".`);
  }
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw new Error('The API returned a download link that is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') throw new Error('The download link is not https; refusing to fetch it.');
  if (!hostAllowed(parsed.hostname, config.allowedHosts)) {
    throw new Error(`The download link points to ${parsed.hostname}, which this tool does not allow.`);
  }

  const res = await fetch(link, { maxBytes: DOWNLOAD_MAX_BYTES, timeoutMs: 60_000 });
  let buf = res.body;
  const marker = config.compressionField ? readPath(apiBody, config.compressionField) : undefined;
  const isGzip = String(marker ?? '').toUpperCase() === 'GZIP' || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
  if (isGzip) {
    try {
      buf = await gunzip(buf, { maxOutputLength: DOWNLOAD_MAX_DECOMPRESSED_BYTES });
    } catch (e: any) {
      if (e?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String(e?.message))) {
        throw new Error(
          `The file is larger than ${DOWNLOAD_MAX_DECOMPRESSED_BYTES / 1024 / 1024} MB once decompressed. Request a report for a shorter date range.`,
        );
      }
      throw new Error('The file could not be decompressed (it is not valid gzip).');
    }
  }

  const text = decodeText(buf, res.headers['content-type']);
  const format = config.format && config.format !== 'auto' ? config.format : detectFormat(text);
  const sizeBytes = buf.length;

  if (format === 'json') {
    try {
      return { format, sizeBytes, data: JSON.parse(text) };
    } catch {
      throw new Error('The file looks like JSON but could not be parsed.');
    }
  }
  if (format === 'text') {
    return {
      format,
      sizeBytes,
      text: text.slice(0, TEXT_PREVIEW_CHARS),
      truncated: text.length > TEXT_PREVIEW_CHARS,
    };
  }

  const records = parseDelimited(text, format === 'tsv' ? '\t' : ',');
  return {
    format,
    sizeBytes,
    ...pageRows(records, {
      offset: toInt(arg(params, config.offset), 0, 0, Number.MAX_SAFE_INTEGER),
      limit: toInt(arg(params, config.limit), DOWNLOAD_DEFAULT_LIMIT, 1, DOWNLOAD_MAX_LIMIT),
      columns: toList(arg(params, config.columns)),
      filterColumn: arg(params, config.filterColumn) as string | undefined,
      filterValues: toList(arg(params, config.filterValue)),
    }),
  };
}
