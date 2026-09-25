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
import { scrubBreadcrumb, scrubEvent } from './common/sentry-scrub';

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
    release: process.env.SENTRY_RELEASE || process.env.npm_package_version,

    // Tracing is opt-in on top of error reporting because it adds overhead.
    tracesSampleRate: sample(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.0),
    profilesSampleRate: sample(process.env.SENTRY_PROFILES_SAMPLE_RATE, 0.0),

    sendDefaultPii: false,

    integrations: [
      // The SDK attaches incoming request bodies by default ('medium'). On
      // this server that is the arguments of every MCP tool call.
      Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' }),
      Sentry.requestDataIntegration({
        include: {
          cookies: false,
          data: false,
          headers: true, // reduced to user-agent in scrubEvent
          ip: false,
          query_string: false,
          url: true, // query and fragment stripped in scrubEvent
        },
      }),
    ],

    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
