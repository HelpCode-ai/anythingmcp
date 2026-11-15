'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { NextIntlClientProvider, useMessages, useTimeZone } from 'next-intl';
import { pickPaywallLang, type PaywallExtraLang } from '@/lib/paywall-lang';

type Messages = Record<string, unknown>;

// One small file per language, fetched only by a browser that asks for it.
const LOADERS: Record<PaywallExtraLang, () => Promise<{ default: Messages }>> = {
  es: () => import('../../messages/paywall/es.json'),
  zh: () => import('../../messages/paywall/zh.json'),
  ja: () => import('../../messages/paywall/ja.json'),
  ru: () => import('../../messages/paywall/ru.json'),
};

/**
 * The paywall in the visitor's language.
 *
 * The dashboard has three languages (English, German, Italian); the website
 * and the no-login reactivation page have seven. Someone whose browser asks
 * for Spanish, Chinese, Japanese or Russian reads the pages that ask for
 * money in that language too: the licence wall, the card-trial page and the
 * trial banner. Their words come from messages/paywall/<lang>.json, laid over
 * the dashboard's messages for this subtree only.
 *
 * The language is read after mount (the server has no browser languages), so
 * nothing is rendered before it is known: no English flash before Spanish.
 * `fallback` is shown meanwhile. A file that fails to load leaves the
 * dashboard's language.
 */
export function PaywallIntl({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const appMessages = useMessages();
  const timeZone = useTimeZone();
  // undefined: not known yet. null: the dashboard's own language.
  const [extra, setExtra] = useState<{ lang: PaywallExtraLang; messages: Messages } | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const lang = pickPaywallLang(
      document.cookie,
      navigator.languages?.length ? navigator.languages : [navigator.language],
    );
    if (!lang) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExtra(null);
      return;
    }
    LOADERS[lang]()
      .then((mod) => {
        if (!cancelled) setExtra({ lang, messages: mod.default });
      })
      .catch(() => {
        if (!cancelled) setExtra(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (extra === undefined) return <>{fallback}</>;
  if (!extra) return <>{children}</>;
  return (
    <NextIntlClientProvider locale={extra.lang} messages={{ ...appMessages, ...extra.messages }} timeZone={timeZone}>
      <div lang={extra.lang} className="contents">
        {children}
      </div>
    </NextIntlClientProvider>
  );
}
