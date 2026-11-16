import { isLocale } from '@/i18n/config';

/**
 * The languages the paywall speaks beyond the dashboard's own (see
 * PaywallIntl): the rest of the website's seven.
 */
export const PAYWALL_EXTRA_LANGS = ['es', 'zh', 'ja', 'ru'] as const;
export type PaywallExtraLang = (typeof PAYWALL_EXTRA_LANGS)[number];

function primary(tag: string | null | undefined): string {
  return (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * The extra language for the paywall, or null when the dashboard's language
 * applies.
 *
 * A language picked in the dashboard (the amcp_locale cookie) always wins.
 * Otherwise the browser's languages are read in order: the first one the
 * dashboard or the paywall has decides, so `es-MX, en` is Spanish and
 * `de, es` stays with the dashboard's German.
 */
export function pickPaywallLang(cookie: string, browserLanguages: readonly string[]): PaywallExtraLang | null {
  const chosen = primary(/(?:^|;\s*)amcp_locale=([^;]+)/.exec(cookie)?.[1]);
  if (isLocale(chosen)) return null;
  for (const tag of browserLanguages) {
    const lang = primary(tag);
    if (isLocale(lang)) return null;
    if ((PAYWALL_EXTRA_LANGS as readonly string[]).includes(lang)) return lang as PaywallExtraLang;
  }
  return null;
}
