// UI languages. English is the source: every key is defined in
// messages/en.json, and the other files translate it.
export const LOCALES = ['en', 'de', 'it'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

// A per-browser preference, not a workspace or instance setting, so members of
// one workspace (and signed-out visitors on /login) can use different languages.
export const LOCALE_COOKIE = 'amcp_locale';

// Each language in its own name, as the language switcher lists it. Adding a
// language means adding it here as well as to LOCALES and messages/.
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  it: 'Italiano',
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/**
 * The best supported language for an Accept-Language header, by quality.
 * Only the primary subtag is compared (`de-AT` → `de`); `*` and unsupported
 * languages are skipped, so `fr-FR` falls through to English.
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const quality = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), quality: Number.isNaN(quality) ? 0 : quality, index };
    })
    .filter((entry) => entry.tag && entry.tag !== '*' && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  for (const { tag } of ranked) {
    const primary = tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}

/** Cookie if it holds a supported locale, otherwise Accept-Language, otherwise English. */
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  return matchAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}
