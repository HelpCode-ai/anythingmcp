'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { clearAuthorizationReturn, isAuthorizationPath, readAuthorizationReturn } from '@/lib/card-trial';
import { safeRedirect } from '@/lib/safe-redirect';
import {
  fetchPendingAuthorization,
  pendingAuthorizationPath,
  type PendingAuthorization,
} from '@/lib/pending-authorization';

/** The backend is asked at most this often, however many pages are opened. */
const MIN_ASK_INTERVAL_MS = 5000;

/** Set on <html> while the bar shows, so the app shell can make room for it. */
const HEIGHT_VAR = '--pending-authorization-bar-h';

/**
 * Pages that are themselves the way back, so the bar would only repeat them:
 * - the sign-in or sign-up an authorization page opened
 *   (`/login?redirect=/auth/…`), which returns there when it is done;
 * - the card-trial page while it holds an authorization to return to (it says
 *   so under its title, and every way out of it goes back).
 */
function pageIsTheWayBack(pathname: string | null): boolean {
  if (typeof window === 'undefined') return true;
  const query = new URLSearchParams(window.location.search);
  if (pathname === '/login') return safeRedirect(query.get('redirect')).startsWith('/auth/');
  if (pathname === '/start-trial') return isAuthorizationPath(query.get('return')) || readAuthorizationReturn() !== null;
  return false;
}

/**
 * Cloud only: "Claude is not connected yet" across the top of every dashboard
 * page while an AI client's authorization started in this browser is still
 * open. Someone who pressed "Connect" in Claude and then ended up in the
 * dashboard (to add an app first, after the card-trial page, in a second tab)
 * otherwise has no sign that the connection was never finished, and no way
 * back to it.
 *
 * The backend says whether one is waiting and at which step (see
 * lib/pending-authorization.ts); the bar offers the matching backend page.
 * It sits in the normal flow above the page, so it pushes the content down
 * instead of covering it. Self-hosted instances never ask and never show it.
 */
export function PendingAuthorizationBar() {
  const { deploymentMode, deploymentModeLoaded } = useAuth();
  const pathname = usePathname();
  const t = useTranslations('pendingAuthorization');
  const [pending, setPending] = useState<PendingAuthorization | null>(null);
  const [leaving, setLeaving] = useState(false);
  const lastAsked = useRef(0);
  const later = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const barRef = useRef<HTMLElement | null>(null);
  const isCloud = deploymentModeLoaded && deploymentMode === 'cloud';

  /** Asks now, or once the interval since the last question is over. */
  const ask = useCallback(() => {
    const run = () => {
      later.current = null;
      lastAsked.current = Date.now();
      void fetchPendingAuthorization().then((answer) => {
        if (mounted.current) setPending(answer);
      });
    };
    const wait = lastAsked.current + MIN_ASK_INTERVAL_MS - Date.now();
    if (wait <= 0) run();
    else if (!later.current) later.current = setTimeout(run, wait);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (later.current) clearTimeout(later.current);
      later.current = null;
    };
  }, []);

  // On arrival and on every page change.
  useEffect(() => {
    if (isCloud) ask();
  }, [isCloud, pathname, ask]);

  // Back in this tab: the authorization may have been finished, or started,
  // in another one. `pageshow` covers a page restored by the Back button.
  useEffect(() => {
    if (!isCloud) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setLeaving(false);
      ask();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, [isCloud, ask]);

  const visible = isCloud && pending !== null && !pageIsTheWayBack(pathname);

  // The app shell is exactly one screen tall; it takes the bar's height off
  // (see app-shell.tsx), so the page does not grow a second scrollbar.
  useEffect(() => {
    const bar = barRef.current;
    if (!visible || !bar) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(HEIGHT_VAR, `${bar.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(HEIGHT_VAR);
    };
  }, [visible]);

  if (!visible || !pending) return null;

  const { client, step } = pending;
  const goBack = () => {
    setLeaving(true);
    // The way back is being followed: a return kept for the card-trial detour
    // must not send anyone there a second time.
    clearAuthorizationReturn();
    // A backend page on this origin, not a Next route: a full navigation.
    window.location.assign(pendingAuthorizationPath(step));
  };

  return (
    <section
      ref={barRef}
      aria-label={t('label')}
      data-testid="pending-authorization-bar"
      data-step={step}
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 bg-[var(--brand)] px-4 py-2 text-center text-[13.5px] font-medium text-[var(--primary-foreground)]"
    >
      <p className="min-w-0 break-words">
        {client ? t(`${step}.text`, { client }) : t(`${step}.textGeneric`)}
      </p>
      <button
        type="button"
        onClick={goBack}
        disabled={leaving}
        className="inline-flex min-h-8 max-w-full items-center justify-center rounded-[9px] bg-[var(--primary-foreground)] px-3 py-1 text-[13px] font-semibold text-[var(--brand)] transition-opacity hover:opacity-90 focus-visible:[outline-color:var(--primary-foreground)] disabled:opacity-70"
      >
        <span className="min-w-0 break-words">
          {client ? t(`${step}.action`, { client }) : t(`${step}.actionGeneric`)}
        </span>
      </button>
    </section>
  );
}
