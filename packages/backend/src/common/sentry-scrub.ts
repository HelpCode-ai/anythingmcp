/**
 * What the backend lets through to Sentry.
 *
 * Allowlist, not blocklist. This server handles MCP tool arguments, the
 * responses of customers' own systems, OAuth authorization codes and API keys
 * that some upstream APIs take in the query string. Naming the fields to
 * redact would always miss the next one, so everything that can carry them is
 * dropped and only what is needed to find a bug is kept:
 *
 * - request: method, and the URL without query string or fragment;
 * - headers: user-agent only;
 * - no request body, cookies, query string, IP or user;
 * - outgoing HTTP (breadcrumbs and spans): URL without query string;
 * - console breadcrumbs dropped: a log line can quote anything.
 */
import type { Breadcrumb, Event } from '@sentry/nestjs';

const KEPT_HEADERS = new Set(['user-agent']);

/** URL without query string or fragment. Unparseable input is cut at ? or #. */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** Removes every `?query` and `#fragment` from a free-text span name. */
export function cutQueries(text: string): string {
  return text.replace(/[?#][^\s]*/g, '');
}

// Span attributes that hold a URL or its query, across the OpenTelemetry
// semantic-convention versions the SDK emits.
const URL_KEYS = ['http.url', 'url.full', 'http.target', 'url'];
const QUERY_KEYS = ['http.query', 'url.query', 'http.fragment', 'url.fragment'];

function scrubUrlData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const k of URL_KEYS) {
    if (typeof data[k] === 'string') data[k] = stripQuery(data[k] as string);
  }
  for (const k of QUERY_KEYS) delete data[k];
}

export function scrubEvent<T extends Event>(event: T): T {
  const req = event.request;
  if (req) {
    delete req.data;
    delete req.cookies;
    delete req.query_string;
    delete req.env;
    if (typeof req.url === 'string') req.url = stripQuery(req.url);
    if (req.headers) {
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (KEPT_HEADERS.has(k.toLowerCase())) kept[k] = v;
      }
      req.headers = kept;
    }
  }

  delete event.user;

  for (const b of event.breadcrumbs ?? []) scrubUrlData(b.data);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.filter((b) => b.category !== 'console');
  }

  // HTTP span names and transaction names are "GET /callback?code=…" or
  // "GET https://api.example.com/v1?key=…": cut every query they carry.
  for (const span of event.spans ?? []) {
    scrubUrlData(span.data as Record<string, unknown> | undefined);
    if (typeof span.description === 'string' && span.op?.startsWith('http')) {
      span.description = cutQueries(span.description);
    }
  }
  scrubUrlData(event.contexts?.trace?.data as Record<string, unknown> | undefined);
  if (typeof event.transaction === 'string') {
    event.transaction = cutQueries(event.transaction);
  }

  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null;
  scrubUrlData(breadcrumb.data);
  return breadcrumb;
}
