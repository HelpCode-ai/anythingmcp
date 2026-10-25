'use client';

import { useId, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Languages } from 'lucide-react';
import { LOCALES, LOCALE_COOKIE, LOCALE_NAMES, isLocale } from '@/i18n/config';
import { cn } from '@/lib/utils';

const ONE_YEAR = 365 * 24 * 60 * 60;

/**
 * The UI language for this browser: a select listing each language in its
 * own name. The choice goes into the amcp_locale cookie, which the server
 * reads on every request (src/i18n/request.ts), and the page is refreshed so
 * the server components render again in the new language. Signing out does
 * not clear it: it belongs to the browser, not the session.
 *
 * `field` is the labelled form field for Settings → Profile; `compact` is the
 * small one under the sign-in card.
 */
export function LanguageSwitcher({ variant = 'field' }: { variant?: 'field' | 'compact' }) {
  const t = useTranslations('language');
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const id = useId();

  const change = (value: string) => {
    if (!isLocale(value) || value === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${value}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax`;
    startTransition(() => router.refresh());
  };

  const options = LOCALES.map((l) => (
    <option key={l} value={l} lang={l}>
      {LOCALE_NAMES[l]}
    </option>
  ));

  if (variant === 'compact') {
    return (
      <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-[var(--text-3)]">
        <Languages aria-hidden className="h-3.5 w-3.5" />
        <label htmlFor={id} className="sr-only">
          {t('label')}
        </label>
        <select
          id={id}
          value={locale}
          onChange={(e) => change(e.target.value)}
          disabled={pending}
          className="cursor-pointer rounded-[6px] bg-transparent py-0.5 text-xs text-[var(--text-2)] outline-none hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--brand-ring)] disabled:opacity-60"
        >
          {options}
        </select>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={id} className="block text-[12.5px] font-medium text-[var(--text-2)] mb-1">
        {t('label')}
      </label>
      <select
        id={id}
        value={locale}
        onChange={(e) => change(e.target.value)}
        disabled={pending}
        className={cn(
          'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]',
          'disabled:opacity-60',
        )}
      >
        {options}
      </select>
      <p className="mt-1 text-xs text-[var(--text-3)]">{t('hint')}</p>
    </div>
  );
}
