/**
 * Sentry instrumentation — must be imported BEFORE any other application
 * code so the auto-instrumentation can wrap http / express / prisma.
 *
 * Opt-in: SENTRY_DSN unset → no-op. Self-hosted users see no behaviour
 * change unless they explicitly want error reporting.
 *
 * What reaches Sentry is decided by an allowlist, not a blocklist: this
 * server carries MCP tool arguments, connector responses and OAuth codes,
 * i.e. other companies' business data and credentials. See
 * ./common/sentry-scrub.ts for the exact rules.
 */
import * as Sentry from '@sentry/nestjs';
import { APP_VERSION } from './common/app-version';
import { scrubBreadcrumb, scrubEvent, scrubSpan } from './common/sentry-scrub';
import { sampleRateFor } from './common/sentry-sampler';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  const sample = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      'development',
    release: process.env.SENTRY_RELEASE || APP_VERSION,

    // Tracing is opt-in on top of error reporting because it adds overhead.
    // SENTRY_TRACES_SAMPLE_RATE applies to HTTP requests; MCP calls take
    // SENTRY_MCP_TRACES_SAMPLE_RATE (default: a fifth of it); background work
    // and health probes are not traced. See ./common/sentry-sampler.ts.
    tracesSampler: (() => {
      const base = sample(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.0);
      const rates = { base, mcp: sample(process.env.SENTRY_MCP_TRACES_SAMPLE_RATE, base / 5) };
      return (ctx: Parameters<typeof sampleRateFor>[0]) => sampleRateFor(ctx, rates);
    })(),
    // SDK v11 renamed profilesSampleRate. Like before, it has no effect
    // until nodeProfilingIntegration is added to the integrations below.
    profileSessionSampleRate: sample(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0.0),
    profileLifecycle: 'trace',

    // SDK v11 collects request bodies, cookies, headers, query strings, the
    // user, MCP tool arguments and results and GenAI prompts unless told not
    // to. Turn every category off; the scrubbers below remain the allowlist.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },

    integrations: [
      // Never read incoming request bodies. On this server that is the
      // arguments of every MCP tool call.
      Sentry.httpIntegration({ maxRequestBodySize: 'none' }),
    ],

    // raw-body's BadRequestError when the client hangs up before its request
    // body has been read. Nothing failed on our side; a client looping on
    // /mcp/:id and dropping its calls sent 1,388 of these in one burst on
    // 4 Oct 2026 (ANYTHINGMCP-CLOUD-BACKEND-6).
    ignoreErrors: [/^request aborted$/],

    beforeSend: scrubEvent,
    // SDK v11 streams spans instead of sending transactions, so spans are
    // scrubbed one by one here (beforeSendTransaction no longer runs).
    beforeSendSpan: scrubSpan,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
