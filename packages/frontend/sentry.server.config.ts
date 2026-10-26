/**
 * Sentry server-side init for Next.js (Node runtime). No-op when SENTRY_DSN is
 * unset. Read at runtime from the container's env, never baked into the image.
 */
import * as Sentry from '@sentry/nextjs';
import { DATA_COLLECTION, sampleRate, scrubBreadcrumb, scrubEvent, scrubSpan } from './src/lib/sentry-scrub';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: sampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0),
    dataCollection: DATA_COLLECTION,
    integrations: [
      // This server proxies /mcp and /api to the backend: reading request
      // bodies would attach MCP tool arguments to any error on the way.
      Sentry.httpIntegration({ maxRequestBodySize: 'none' }),
    ],
    beforeSend: scrubEvent,
    beforeSendSpan: scrubSpan,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
