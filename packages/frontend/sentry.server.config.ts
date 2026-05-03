/**
 * Sentry server-side init for Next.js. No-op when SENTRY_DSN is unset.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  const sample = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };

  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ||
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
      process.env.NODE_ENV ||
      'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: sample(process.env.SENTRY_TRACES_SAMPLE_RATE, 0),
    sendDefaultPii: false,
  });
}
