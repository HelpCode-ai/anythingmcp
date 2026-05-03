/**
 * Sentry instrumentation — must be imported BEFORE any other application
 * code so the auto-instrumentation can wrap http / express / prisma.
 *
 * Opt-in: SENTRY_DSN unset → no-op. Self-hosted users see no behaviour
 * change unless they explicitly want error reporting.
 *
 * Sensitive headers and DTO fields are scrubbed via Sentry's beforeSend.
 */
import * as Sentry from '@sentry/nestjs';

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

    beforeSend(event) {
      // Strip auth headers and known credential fields. Pino already
      // redacts these in logs; Sentry lives outside that pipeline.
      const headers = event?.request?.headers;
      if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
          const lower = k.toLowerCase();
          if (
            lower === 'authorization' ||
            lower === 'cookie' ||
            lower === 'x-api-key' ||
            lower === 'set-cookie'
          ) {
            (headers as Record<string, unknown>)[k] = '[Redacted]';
          }
        }
      }
      const data = event?.request?.data as unknown;
      if (data && typeof data === 'object') {
        scrub(data as Record<string, unknown>);
      }
      return event;
    },
  });
}

function scrub(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('password') ||
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('apikey') ||
      lower.includes('api_key') ||
      lower.includes('credential')
    ) {
      obj[key] = '[Redacted]';
      continue;
    }
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      scrub(v as Record<string, unknown>);
    }
  }
}
