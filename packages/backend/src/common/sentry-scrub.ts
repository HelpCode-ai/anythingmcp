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
 * - spans: no header but user-agent, no body, query, client address, user,
 *   MCP arguments or results, or GenAI prompts and completions;
 * - console breadcrumbs dropped: a log line can quote anything.
 */
import type { Breadcrumb, Event, NodeOptions } from '@sentry/nestjs';
import { redactSecretLiterals } from './secret-literals.util';

const KEPT_HEADERS = new Set(['user-agent']);

/**
 * URL without query string or fragment. Unparseable input is cut at ? or #.
 * A key in the path itself (Telegram's `/bot<token>/sendMessage`) is
 * redacted too.
 */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${redactSecretLiterals(u.pathname)}`;
  } catch {
    return redactSecretLiterals(url.split(/[?#]/)[0]);
  }
}

/** Removes every `?query` and `#fragment` (and keys in paths) from a free-text span name. */
export function cutQueries(text: string): string {
  return redactSecretLiterals(text.replace(/[?#][^\s]*/g, ''));
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

/** The streamed span the SDK hands to `beforeSendSpan` (SDK v11). */
export type StreamedSpan = Parameters<NonNullable<NodeOptions['beforeSendSpan']>>[0];

// Span attributes that can carry business data or credentials. The SDK is
// told not to collect them (dataCollection in instrument.ts); this is the
// second line of defence, should a later SDK version add one.
const DROPPED_SPAN_ATTRIBUTES: RegExp[] = [
  /^http\.(request|response)\.(header|body)\./,
  /^(user|client)\./,
  /^mcp\.request\.argument/,
  /^mcp\.(tool|prompt)\.result\.(\d+\.)?(content|description|message_content|uri|resource_uri)$/,
  /^mcp\.(logging|progress)\.message$/,
  /^mcp\.resource\.uri$/,
  /^gen_ai\.(input|output|prompt|completion|system_instructions|request\.messages|response\.text|tool\.(input|output|call\.arguments|call\.result))/,
];
const KEPT_HEADER_ATTRIBUTES = new Set(['http.request.header.user-agent', 'http.request.header.user_agent']);

/**
 * The same rules as scrubEvent, for one streamed span: URLs lose their
 * query, request and response headers but user-agent are dropped, and so is
 * anything holding a body, the client, the user or MCP and AI content.
 */
export function scrubSpan(span: StreamedSpan): StreamedSpan {
  const attrs = span.attributes as Record<string, unknown> | undefined;
  if (attrs) {
    scrubUrlData(attrs);
    for (const k of Object.keys(attrs)) {
      if (KEPT_HEADER_ATTRIBUTES.has(k)) continue;
      if (DROPPED_SPAN_ATTRIBUTES.some((re) => re.test(k))) delete attrs[k];
    }
  }
  // HTTP span names and the segment span (the former transaction) can be
  // "GET /callback?code=…". Database span names keep their "?" placeholders.
  const op = attrs?.['sentry.op'];
  if (span.is_segment || (typeof op === 'string' && op.startsWith('http'))) {
    span.name = cutQueries(span.name);
  }
  return span;
}

/**
 * SDK v11's MCP server integration reports every error the MCP transport
 * raises as an unhandled exception. Those errors are the SDK refusing a
 * client's request (wrong Accept header, unknown session, malformed JSON),
 * already answered with a 4xx and logged at WARN, so a crawler on /mcp/demo
 * could open backend issues at will (ANYTHINGMCP-CLOUD-BACKEND-A).
 */
export function isMcpTransportError(event: Event): boolean {
  return (event.exception?.values ?? []).some(
    (value) =>
      value.mechanism?.type === 'auto.ai.mcp_server' &&
      value.mechanism.data?.error_type === 'transport',
  );
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null;
  scrubUrlData(breadcrumb.data);
  return breadcrumb;
}
