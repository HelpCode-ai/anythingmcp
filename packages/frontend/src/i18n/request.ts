import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, LOCALE_COOKIE, resolveLocale } from './config';
import en from '../../messages/en.json';

type Messages = { [key: string]: string | Messages };

// A key missing from a translation falls back to the English text, never to
// the raw key: the English file is the base and the locale's file is laid on top.
function withEnglishFallback(base: Messages, translated: Messages): Messages {
  const merged: Messages = { ...base };
  for (const [key, value] of Object.entries(translated)) {
    const baseValue = base[key];
    merged[key] =
      typeof value === 'object' && typeof baseValue === 'object'
        ? withEnglishFallback(baseValue, value)
        : value;
  }
  return merged;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'));

  const messages =
    locale === DEFAULT_LOCALE
      ? en
      : withEnglishFallback(en, (await import(`../../messages/${locale}.json`)).default);

  return { locale, messages };
});
