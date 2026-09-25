/**
 * Next.js instrumentation entry point. Loaded once per server runtime and
 * delegates to the appropriate Sentry config file based on which runtime
 * Next has booted.
 *
 * No-op everywhere when SENTRY_DSN is unset.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Capture errors thrown from React Server Components / route handlers.
import * as Sentry from '@sentry/nextjs';

export const onRequestError = Sentry.captureRequestError;
