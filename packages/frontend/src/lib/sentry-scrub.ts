/**
 * What the frontend lets through to Sentry. Shared by the browser, server and
 * edge runtimes.
 *
 * Every URL loses its query string and fragment: this app carries invitation,
 * e-mail verification and password-reset tokens in the query, OAuth codes on
 * /authorize and /callback, and licence keys in the fragment of
 * /settings/license/activate. The page path is enough to find a bug.
 * Request bodies, cookies and every header but user-agent are dropped; so is
 * the user. Console breadcrumbs are dropped too, a log line can quote anything.
 */
import type { Breadcrumb, Event } from '@sentry/nextjs';

const KEPT_HEADERS = new Set(['user-agent']);

/** Removes every `?query` and `#fragment`, in a URL or in free text. */
export function cutQueries(text: string): string {
  return text.replace(/[?#][^\s]*/g, '');
}

const URL_KEYS = ['url', 'from', 'to', 'http.url', 'url.full', 'http.target'];
const QUERY_KEYS = ['http.query', 'url.query', 'http.fragment', 'url.fragment'];

function scrubUrlData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const k of URL_KEYS) {
    if (typeof data[k] === 'string') data[k] = cutQueries(data[k] as string);
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
    if (typeof req.url === 'string') req.url = cutQueries(req.url);
    if (req.headers) {
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (KEPT_HEADERS.has(k.toLowerCase())) kept[k] = v;
      }
      req.headers = kept;
    }
  }
  delete event.user;

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.filter((b) => b.category !== 'console');
    for (const b of event.breadcrumbs) scrubUrlData(b.data);
  }
  for (const span of event.spans ?? []) {
    scrubUrlData(span.data as Record<string, unknown> | undefined);
    if (typeof span.description === 'string') span.description = cutQueries(span.description);
  }
  scrubUrlData(event.contexts?.trace?.data as Record<string, unknown> | undefined);
  if (typeof event.transaction === 'string') event.transaction = cutQueries(event.transaction);
  if (event.tags?.url && typeof event.tags.url === 'string') event.tags.url = cutQueries(event.tags.url);

  // Stack frames of browser errors carry the page URL for inline scripts.
  for (const ex of event.exception?.values ?? []) {
    for (const f of ex.stacktrace?.frames ?? []) {
      if (typeof f.abs_path === 'string') f.abs_path = cutQueries(f.abs_path);
      if (typeof f.filename === 'string') f.filename = cutQueries(f.filename);
    }
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null;
  scrubUrlData(breadcrumb.data);
  if (typeof breadcrumb.message === 'string' && breadcrumb.category === 'navigation') {
    breadcrumb.message = cutQueries(breadcrumb.message);
  }
  return breadcrumb;
}

/** Sample rate from an env string, `fallback` when unset or out of [0, 1]. */
export function sampleRate(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * Browser settings, rendered by the root layout from the container's runtime
 * env. The image is the public one self-hosters pull, so nothing about our
 * Sentry project may be baked in at build time.
 */
export interface BrowserSentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate: number;
}

export const BROWSER_CONFIG_GLOBAL = '__AMCP_SENTRY__';
