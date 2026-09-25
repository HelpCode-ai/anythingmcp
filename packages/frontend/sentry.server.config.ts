/**
 * Sentry server-side init for Next.js (Node runtime). No-op when SENTRY_DSN is
 * unset. Read at runtime from the container's env, never baked into the image.
 */
import * as Sentry from '@sentry/nextjs';
import { sampleRate, scrubBreadcrumb, scrubEvent } from './src/lib/sentry-scrub';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: sampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0),
    sendDefaultPii: false,
    integrations: [
      // This server proxies /mcp and /api to the backend: the default would
      // attach MCP tool arguments to any error raised on the way through.
      Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' }),
    ],
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
