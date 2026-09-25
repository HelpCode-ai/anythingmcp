import { BROWSER_CONFIG_GLOBAL, sampleRate, type BrowserSentryConfig } from '@/lib/sentry-scrub';

/**
 * Hands the browser its Sentry settings from the container's runtime env.
 *
 * Same reason as GTM_ID in the root layout: one public image serves both the
 * cloud and self-hosted installations, so the DSN cannot be a build-time
 * NEXT_PUBLIC_ variable. The layout is force-dynamic, so this reads the env
 * of the running container. Renders nothing when SENTRY_DSN is unset.
 */
export function SentryConfig() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;

  const config: BrowserSentryConfig = {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: sampleRate(process.env.SENTRY_BROWSER_TRACES_SAMPLE_RATE, 0),
  };
  // `<` escaped so a value can never close the script element.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return (
    <script
      dangerouslySetInnerHTML={{ __html: `window.${BROWSER_CONFIG_GLOBAL}=${json};` }}
    />
  );
}
