/**
 * Sentry edge runtime init (proxy / Next edge functions). No-op when
 * SENTRY_DSN is unset.
 */
import * as Sentry from '@sentry/nextjs';
import { DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from './src/lib/sentry-scrub';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    dataCollection: DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}
