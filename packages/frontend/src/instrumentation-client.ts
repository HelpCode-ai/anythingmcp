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
  BROWSER_DENY_URLS,
  BROWSER_IGNORE_ERRORS,
  DATA_COLLECTION,
  beforeSendBrowser,
  scrubBreadcrumb,
  scrubSpan,
  type BrowserSentryConfig,
} from '@/lib/sentry-scrub';
import { DOM_GUARD_GLOBAL, DOM_GUARD_MESSAGES, type DomGuardRepair, type DomGuardState } from '@/lib/translation-safe-dom';

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
    dataCollection: DATA_COLLECTION,
    // Drops errors thrown entirely inside scripts the browser injected.
    beforeSend: beforeSendBrowser,
    beforeSendSpan: scrubSpan,
    beforeBreadcrumb: scrubBreadcrumb,
    // Noise from extensions and link scanners: see lib/sentry-scrub.ts.
    ignoreErrors: BROWSER_IGNORE_ERRORS,
    denyUrls: BROWSER_DENY_URLS,
  });
  trailDomGuardRepairs();
}

/**
 * The DOM guard inlined in <head> (lib/translation-safe-dom.ts) repairs what
 * a page translator broke without an error. Each repair becomes a breadcrumb,
 * so an error that still follows shows it; console breadcrumbs are dropped
 * (sentry-scrub.ts), hence the guard's own queue.
 */
function trailDomGuardRepairs(): void {
  const state = (window as unknown as Record<string, DomGuardState | undefined>)[DOM_GUARD_GLOBAL];
  if (!state) return;
  const trail = (repair: DomGuardRepair) =>
    Sentry.addBreadcrumb({ category: 'dom-guard', level: 'warning', message: DOM_GUARD_MESSAGES[repair] });
  state.queue.splice(0).forEach(trail);
  state.listener = trail;
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
