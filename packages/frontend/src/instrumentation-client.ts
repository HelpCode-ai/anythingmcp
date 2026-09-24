/**
 * Browser Sentry init. Loaded by Next.js before the app hydrates.
 *
 * The DSN is not in the bundle: the root layout renders it from the
 * container's env (see components/sentry-config.tsx), so the public Docker
 * image ships nothing to our Sentry and a self-hoster enables their own by
 * setting SENTRY_DSN. No config on the page → no-op.
 */
import * as Sentry from '@sentry/nextjs';
import {
  BROWSER_CONFIG_GLOBAL,
  scrubBreadcrumb,
  scrubEvent,
  type BrowserSentryConfig,
} from '@/lib/sentry-scrub';

function init(): void {
  const config = (window as unknown as Record<string, BrowserSentryConfig | undefined>)[
    BROWSER_CONFIG_GLOBAL
  ];
  if (!config?.dsn || Sentry.isInitialized()) return;

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.tracesSampleRate,
    // Session replay stays off: it would record what users type into
    // connector configurations and credentials forms.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

// The config script sits in <head>, but Next may run this module before the
// parser reaches it; the DOM is complete by DOMContentLoaded.
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
