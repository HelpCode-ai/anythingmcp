'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from '@/lib/theme-context';
import { AppSidebar } from '@/components/app-sidebar';
import { CommandPalette, isMacPlatform } from '@/components/command-palette';
import { Footer } from '@/components/footer';
import { TrialBanner } from '@/components/trial-banner';
import { SubscriptionBanner } from '@/components/subscription-banner';
import { UsageBanner } from '@/components/usage-banner';
import { EditionBanner } from '@/components/edition-banner';
import { cn } from '@/lib/utils';

interface AppShellProps {
  /** Page title shown in the content header. */
  title?: string;
  /** Optional muted subtitle under the title. */
  subtitle?: string;
  /**
   * Breadcrumb trail. The header itself only uses the last entry as the title
   * fallback (the redesign header is title + subtitle, no breadcrumb row).
   * For a back affordance on detail pages, pass `backTo` instead.
   */
  breadcrumbs?: { label: string; href: string }[];
  /** Optional back link rendered as a small "‹ Label" above the title (detail pages). */
  backTo?: { label: string; href: string };
  /** Right-aligned header actions (primary buttons, etc.). */
  actions?: React.ReactNode;
  /** Constrain the content column width (default 1180px to match the redesign). */
  maxWidth?: number | string;
  /** Hide the footer (e.g. for full-bleed graph pages). */
  hideFooter?: boolean;
  children: React.ReactNode;
}

/**
 * Theme toggle. Rendered twice — once in the title row for phones, once in
 * the action group from `md` up — because those are different flex rows and
 * a single node cannot sit in both.
 */
function ThemeToggle({
  isDark,
  setTheme,
  className,
}: {
  isDark: boolean;
  setTheme: ReturnType<typeof useTheme>['setTheme'];
  className?: string;
}) {
  const t = useTranslations('appShell');
  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={t('toggleTheme')}
      aria-label={t('toggleTheme')}
      className={cn(
        'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
        className
      )}
    >
      {isDark ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" /></svg>
      )}
    </button>
  );
}

export function AppShell({
  title,
  subtitle,
  breadcrumbs,
  backTo,
  actions,
  maxWidth = 1180,
  hideFooter = false,
  children,
}: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const t = useTranslations('appShell');
  const isDark = resolvedTheme === 'dark';

  const isMac = useSyncExternalStore(
    () => () => {},
    () => isMacPlatform(),
    () => true
  );
  const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';

  const headerTitle = title ?? breadcrumbs?.[breadcrumbs.length - 1]?.label;

  return (
    <div className="flex h-dvh items-stretch overflow-hidden">
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <AppSidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Global banners (in-flow, above the header) */}
        <div className="flex-shrink-0">
          <TrialBanner />
          <SubscriptionBanner />
          <UsageBanner />
          <EditionBanner />
        </div>
        {/* Content header */}
        {/* Phones get two rows: the title owns the first one — so it is never
            squeezed into an ellipsis by whatever the page puts in its toolbar
            — and the toolbar owns the second, aligned with the title and the
            content below it. The subtitle is desktop-only: at this width it
            only ever rendered as a cut-off half-sentence. From md up
            everything sits on one line, as before. */}
        <header
          className="sticky top-0 z-30 flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] px-4 py-2 backdrop-blur-md sm:px-6 md:min-h-[60px] md:py-2.5"
          style={{ background: 'color-mix(in srgb, var(--bg) 80%, transparent)' }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3 max-md:basis-full">
            <button
              onClick={() => setMobileOpen(true)}
              aria-label={t('openNavigation')}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] md:hidden"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
            </button>
            <div className="min-w-0 flex-1">
              {backTo && (
                <Link
                  href={backTo.href}
                  className="mb-0.5 flex items-center gap-1 text-[12px] text-[var(--text-3)] hover:text-[var(--text)]"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
                  {backTo.label}
                </Link>
              )}
              {headerTitle && (
                <div className="truncate text-[16px] font-semibold tracking-[-0.02em]">{headerTitle}</div>
              )}
              {subtitle && (
                <div className="mt-px hidden truncate text-[12.5px] text-[var(--text-3)] md:block">{subtitle}</div>
              )}
            </div>
            {/* Phones: the search button and theme toggle ride the title row, so the second row
                belongs entirely to the page's own actions. */}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label={t('openCommandPalette')}
              title={t('commandPaletteTitle', { shortcut: shortcutLabel })}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] md:hidden"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
            <ThemeToggle isDark={isDark} setTheme={setTheme} className="md:hidden" />
          </div>

          <div className="flex items-center gap-2.5 max-md:contents">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label={t('searchLabel', { shortcut: shortcutLabel })}
              className="flex h-9 items-center gap-2 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text-3)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] max-md:hidden"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <span className="text-[13px] text-[var(--text-2)]">{t('search')}</span>
              <kbd className="ml-1 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-3)]">
                {shortcutLabel}
              </kbd>
            </button>
            <ThemeToggle isDark={isDark} setTheme={setTheme} className="max-md:hidden" />
            {actions && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 max-md:grow max-md:justify-start md:justify-end">
                {actions}
              </div>
            )}
          </div>
        </header>

        {/* Scrollable content */}
        {/* Column layout so the footer sits at the bottom of the viewport when
            content is short, and after the content (with spacing) when it's tall. */}
        {/* `relative` makes this the containing block for any absolutely-
            positioned descendants (e.g. Tailwind `sr-only` checkbox inputs) so
            they don't anchor to the document and inflate its scroll height,
            which would let the whole page scroll behind the fixed sidebar. */}
        <main className="relative flex flex-1 flex-col overflow-y-auto">
          <div className={cn('mx-auto w-full flex-1 p-4 sm:p-6')} style={{ maxWidth }}>
            {children}
          </div>
          {!hideFooter && (
            <div className="mx-auto mt-10 w-full px-4 pb-4 sm:px-6" style={{ maxWidth }}>
              <Footer />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
