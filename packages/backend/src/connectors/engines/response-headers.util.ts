/**
 * The few response headers a tool may ask to see.
 *
 * A REST tool normally gets the body and nothing else, which is right for
 * almost every call and wrong for exactly one kind: list endpoints that
 * paginate through a `Link` header (GitHub, GitLab, Sentry, Shopify, ...).
 * The model can pass a `cursor` in, but never learns the next one, so every
 * such tool is one page long. Rate-limit headers are the other honest use.
 *
 * A tool opts in with `endpointMapping.exposeHeaders: ["link", ...]`. Nothing
 * here runs for a tool that did not ask.
 */

/** Header names an adapter may ask for, matched case-insensitively. */
export function pickExposedHeaders(
  headers: Record<string, unknown> | undefined,
  names: string[] | undefined,
): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!headers || !names?.length) return picked;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!wanted.has(name) || value === undefined || value === null) continue;
    picked[name] = Array.isArray(value)
      ? value.map(String).join(', ')
      : String(value);
  }
  return picked;
}

/** RFC 8288 `Link` header → { rel: url }. Tolerant of the usual sloppiness. */
export function parseLinkHeader(value: string): Record<string, string> {
  const rels: Record<string, string> = {};
  for (const part of value.split(',')) {
    const m = part.match(/<\s*([^>]*)\s*>\s*;([^]*)/);
    if (!m) continue;
    const url = m[1].trim();
    const rel = m[2].match(/\brel\s*=\s*"?([^";]+)"?/i)?.[1]?.trim();
    if (!rel) continue;
    // A single rel attribute may list several tokens: rel="next last".
    for (const token of rel.split(/\s+/)) {
      if (token && !(token in rels)) rels[token] = url;
    }
  }
  return rels;
}

/** Query parameters that, in practice, carry the "where to continue" value. */
const CURSOR_PARAMS = [
  'cursor',
  'page_token',
  'pageToken',
  'starting_after',
  'after',
  'offset',
  'page',
  'page_info',
  'continuation',
];

export interface Pagination {
  /** The full URL of the next page, exactly as the API sent it. */
  nextUrl: string;
  /** The value to pass back as the tool's cursor parameter, when recognisable. */
  nextCursor?: string;
  /** Which query parameter that value belongs to (`cursor`, `page`, ...). */
  cursorParam?: string;
  /** Present when the API also announced a previous page. */
  prevUrl?: string;
}

/**
 * What a model needs to fetch the next page, lifted out of `Link`. Returns
 * undefined when there is no `next` relation — that is the "last page"
 * signal, and it should read as absence, not as an empty object.
 */
export function describePagination(
  headers: Record<string, string>,
): Pagination | undefined {
  const link = headers['link'];
  if (!link) return undefined;
  const rels = parseLinkHeader(link);
  if (!rels.next) return undefined;

  const page: Pagination = { nextUrl: rels.next };
  if (rels.prev) page.prevUrl = rels.prev;
  try {
    const params = new URL(rels.next).searchParams;
    for (const name of CURSOR_PARAMS) {
      const v = params.get(name);
      if (v !== null && v !== '') {
        page.nextCursor = v;
        page.cursorParam = name;
        break;
      }
    }
  } catch {
    // Relative or malformed URL: nextUrl is still useful on its own.
  }
  return page;
}
