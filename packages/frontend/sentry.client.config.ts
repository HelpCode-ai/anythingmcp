/**
 * Sentry client init. No-op when NEXT_PUBLIC_SENTRY_DSN is unset, so the
 * default self-hosted experience ships nothing to Sentry.
 *
 * Sample rates default to 0 — operators who want tracing/replay must set
 * NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE and NEXT_PUBLIC_SENTRY_REPLAYS_SAMPLE_RATE
 * explicitly.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  const sample = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };

  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      'development',
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    tracesSampleRate: sample(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0),
    replaysSessionSampleRate: sample(
      process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SAMPLE_RATE,
      0,
    ),
    replaysOnErrorSampleRate: sample(
      process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
      0,
    ),
    sendDefaultPii: false,
  });
}
