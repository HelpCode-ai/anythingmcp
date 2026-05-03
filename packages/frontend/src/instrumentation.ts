/**
 * Next.js instrumentation entry point. Loaded once per server runtime and
 * delegates to the appropriate Sentry config file based on which runtime
 * Next has booted.
 *
 * No-op everywhere when SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN are unset.
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
// Wrapper instead of re-exporting so a missing helper in older sentry
// versions doesn't break the build.
import * as SentryNext from '@sentry/nextjs';

type CaptureFn = (
  err: unknown,
  request: Request,
  context: { routerKind: string; routePath: string; routeType: string },
) => void | Promise<void>;

export const onRequestError: CaptureFn = async (err, request, context) => {
  const fn = (SentryNext as unknown as { captureRequestError?: CaptureFn })
    .captureRequestError;
  if (typeof fn === 'function') {
    await fn(err, request, context);
  }
};
