/**
 * Which traces reach Sentry.
 *
 * A flat 5 % rate sent about 700,000 spans a day in September 2026, far past
 * what a Sentry plan includes. Most of them were not requests at all:
 *
 * - root spans with no request behind them: Prisma and pg-pool spans from
 *   the knowledge-graph cron and other background work, each one sampled as
 *   a transaction of its own;
 * - MCP tool calls, the bulk of the traffic, each carrying dozens of database
 *   spans.
 *
 * So: only incoming HTTP requests are traced; MCP calls at a lower rate than
 * the rest (they are many and alike); health probes never. The decision of
 * an incoming trace is not inherited: MCP clients send their own sampled
 * traceparent, and that must not decide our volume.
 */

export interface SamplerRates {
  /** Every HTTP request other than MCP and health probes. */
  base: number;
  /** POST /mcp/:serverId and the other MCP transport routes. */
  mcp: number;
}

interface SamplingInput {
  name: string;
  attributes?: Record<string, unknown>;
  normalizedRequest?: { url?: string; method?: string };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The request path, from whichever of the places it can be at sampling time. */
function requestPath(ctx: SamplingInput): string | undefined {
  const a = ctx.attributes ?? {};
  const raw =
    str(a['url.path']) ??
    str(a['http.target']) ??
    str(a['http.route']) ??
    str(a['url.full']) ??
    str(a['http.url']) ??
    str(ctx.normalizedRequest?.url);
  if (!raw) {
    // "POST /mcp/abc" — the span name once the route is known.
    const m = /^[A-Z]+ (\/\S*)/.exec(ctx.name);
    return m?.[1];
  }
  try {
    return raw.startsWith('/') ? raw.split('?')[0] : new URL(raw).pathname;
  } catch {
    return raw.split('?')[0];
  }
}

function isHttpRequest(ctx: SamplingInput): boolean {
  const a = ctx.attributes ?? {};
  return Boolean(
    str(a['http.request.method']) ??
      str(a['http.method']) ??
      str(ctx.normalizedRequest?.method) ??
      (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(ctx.name) ? 'yes' : undefined),
  );
}

export function sampleRateFor(ctx: SamplingInput, rates: SamplerRates): number {
  if (!isHttpRequest(ctx)) return 0;
  const path = requestPath(ctx) ?? '';
  if (/^\/health(\/|$)/.test(path)) return 0;
  if (/^\/mcp(\/|$)/.test(path)) return rates.mcp;
  return rates.base;
}
