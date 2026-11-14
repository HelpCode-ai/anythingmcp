/**
 * Next.js instrumentation entry point. Loaded once per server runtime and
 * delegates to the appropriate Sentry config file based on which runtime
 * Next has booted.
 *
 * No-op everywhere when SENTRY_DSN is unset.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Proxied rewrites plus Sentry put 13 `close` listeners on one response;
    // see lib/response-listener-limit.ts. Applies with or without SENTRY_DSN.
    const { raiseResponseListenerLimit } = await import('./lib/response-listener-limit');
    raiseResponseListenerLimit();
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Capture errors thrown from React Server Components / route handlers.
import * as Sentry from '@sentry/nextjs';

export const onRequestError = Sentry.captureRequestError;
