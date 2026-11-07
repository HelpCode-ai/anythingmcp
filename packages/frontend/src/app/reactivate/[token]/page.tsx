'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ApiError, reactivation, type ReactivationView } from '@/lib/api';
import { useTrustStats } from '@/lib/trust-stats';
import { CHATGPT_DIRECTORY_URL, CLAUDE_DIRECTORY_URL, getMarketingUrl } from '@/lib/marketing';
import {
  DEFAULT_SELECTION,
  planById,
  selectionForUsage,
  type PlanSelection,
} from '@/lib/card-trial';
import { PlanPicker } from '@/components/plan-picker';
import { LogoIcon } from '@/components/logo-icon';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** How often the page asks whether the payment reached the workspace, and for how long. */
const PAID_POLL_MS = 4000;
const PAID_POLL_LIMIT = 90;

/**
 * The page an AI client links to when a tool call is refused because the
 * workspace's trial ended (A/B against the pricing page). No sign-in: the
 * token names the workspace, and the checkout it opens is for that workspace
 * alone, so the paid licence reaches it without anyone activating a key.
 * Back from Stripe (`?paid=1`) it waits until the workspace is active.
 */
export default function ReactivatePage() {
  // useSearchParams (the ?paid=1 return from Stripe) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ReactivateContent />
    </Suspense>
  );
}

function ReactivateContent() {
  const t = useTranslations('reactivate');
  const locale = useLocale();
  const { token } = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const backFromStripe = searchParams.get('paid') === '1';
  const [view, setView] = useState<ReactivationView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selection, setSelection] = useState<PlanSelection>(DEFAULT_SELECTION);
  const picked = useRef(false);
  const [opening, setOpening] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [pollsLeft, setPollsLeft] = useState(PAID_POLL_LIMIT);
  const trust = useTrustStats();
  const marketing = getMarketingUrl();

  useEffect(() => {
    let cancelled = false;
    reactivation
      .get(token)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        if (!picked.current) setSelection(selectionForUsage(DEFAULT_SELECTION, v.usage));
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Back from Stripe: the paid licence reaches the workspace in 2-3 minutes
  // (the backend binds a licence once it is two minutes old, sweeping every minute).
  useEffect(() => {
    if (!backFromStripe || !view || view.state === 'active' || pollsLeft <= 0) return;
    const timer = setTimeout(() => {
      reactivation
        .get(token)
        .then(setView)
        .catch(() => {})
        .finally(() => setPollsLeft((n) => n - 1));
    }, PAID_POLL_MS);
    return () => clearTimeout(timer);
  }, [backFromStripe, view, pollsLeft, token]);

  const pickPlan = (next: PlanSelection) => {
    picked.current = true;
    setSelection(next);
  };

  const subscribe = async () => {
    setOpening(true);
    setCheckoutError(null);
    try {
      const { url } = await reactivation.checkout(token, {
        plan: selection.plan,
        billingPeriod: selection.period,
      });
      window.location.href = url;
    } catch (e) {
      setCheckoutError(e instanceof ApiError && e.status === 409 ? e.message : t('checkoutFailed'));
      setOpening(false);
    }
  };

  const client = view?.client ?? null;
  const clientName = client ?? t('yourAi');
  const endedOn = view?.trialEndedAt
    ? new Date(view.trialEndedAt).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' })
    : null;
  const plan = planById(selection.plan);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <a href={marketing} className="flex items-center gap-2 font-semibold" target="_blank" rel="noopener noreferrer">
            <LogoIcon size={26} />
            <span>AnythingMCP</span>
          </a>
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-2)]">
            <LockIcon />
            {t('secureCheckout')}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:py-12">
        {!view && !notFound && !loadError && (
          <p className="py-24 text-center text-sm text-[var(--text-3)]">{t('loading')}</p>
        )}

        {(notFound || loadError) && (
          <Notice
            title={notFound ? t('expiredTitle') : t('errorTitle')}
            body={notFound ? t('expiredBody') : t('errorBody')}
            action={{ href: '/login', label: t('signIn') }}
          />
        )}

        {view && view.state === 'active' && (
          <Notice
            tone="success"
            title={backFromStripe ? t('paidTitle') : t('activeTitle')}
            body={t('activeBody', { client: clientName, workspace: view.workspaceName })}
            action={{ href: '/', label: t('openDashboard') }}
          />
        )}

        {view && view.state !== 'active' && backFromStripe && (
          <Notice
            title={t('processingTitle')}
            body={pollsLeft > 0 ? t('processingBody') : t('processingSlow')}
            action={{ href: '/login', label: t('signIn') }}
          />
        )}

        {view && view.state === 'payment-failed' && !backFromStripe && (
          <Notice
            title={t('paymentFailedTitle')}
            body={t('paymentFailedBody')}
            action={{ href: '/login', label: t('signIn') }}
          />
        )}

        {view && (view.state === 'trial-ended' || view.state === 'no-license') && !backFromStripe && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-10">
            <section aria-labelledby="reactivate-title">
              <p className="mb-3 inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--text-2)]">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]" aria-hidden />
                <span className="truncate">
                  {t('workspace')}: <span className="font-medium text-[var(--text)]">{view.workspaceName}</span>
                </span>
              </p>
              <h1 id="reactivate-title" className="text-[28px] font-bold leading-tight tracking-tight sm:text-[34px]">
                {t('title', { client: clientName })}
              </h1>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--text-2)]">
                {endedOn ? t('bodyEnded', { date: endedOn, client: clientName }) : t('body', { client: clientName })}
              </p>

              <div className="mt-6 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-6">
                <PlanPicker value={selection} onChange={pickPlan} disabled={opening} usage={view.usage} />
                <button
                  type="button"
                  onClick={subscribe}
                  disabled={opening}
                  className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-5 w-full text-[15px]')}
                >
                  {opening ? t('opening') : t('cta', { plan: plan.name })}
                </button>
                {checkoutError && (
                  <p role="alert" className="mt-2 text-center text-xs text-[var(--danger)]">
                    {checkoutError}
                  </p>
                )}
                <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-[var(--text-2)]">
                  {[t('trust.cancel'), t('trust.stripe'), t('trust.noSetup')].map((item) => (
                    <li key={item} className="inline-flex items-center gap-1">
                      <Check />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <aside className="space-y-4">
              <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                <h2 className="text-sm font-semibold">{t('next.title')}</h2>
                <ol className="mt-4 space-y-4">
                  {[
                    { title: t('next.payTitle'), body: t('next.payBody') },
                    { title: t('next.activeTitle'), body: t('next.activeBody') },
                    { title: t('next.backTitle', { client: clientName }), body: t('next.backBody', { client: clientName }) },
                  ].map((step, i) => (
                    <li key={step.title} className="flex gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--brand-tint)] text-xs font-semibold text-[var(--brand)]">
                        {i + 1}
                      </span>
                      <div>
                        <p className="text-sm font-medium">{step.title}</p>
                        <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--text-2)]">{step.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                <h2 className="text-sm font-semibold">{t('why.title')}</h2>
                <ul className="mt-3 space-y-2.5 text-[13px] text-[var(--text-2)]">
                  <TrustRow>{t('why.kept')}</TrustRow>
                  <TrustRow>{t('why.cancel')}</TrustRow>
                  <TrustRow>{t('why.eu')}</TrustRow>
                  <TrustRow>
                    {t.rich('why.directories', {
                      claude: (chunks) => (
                        <a href={CLAUDE_DIRECTORY_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--brand)] hover:underline">
                          {chunks}
                        </a>
                      ),
                      chatgpt: (chunks) => (
                        <a href={CHATGPT_DIRECTORY_URL} target="_blank" rel="noopener noreferrer" className="text-[var(--brand)] hover:underline">
                          {chunks}
                        </a>
                      ),
                    })}
                  </TrustRow>
                  {trust?.workspaces && <TrustRow>{t('why.workspaces', { count: trust.workspaces })}</TrustRow>}
                </ul>
              </div>

              <p className="px-1 text-xs leading-relaxed text-[var(--text-3)]">
                {t.rich('questions', {
                  mail: (chunks) => (
                    <a href="mailto:support@anythingmcp.com" className="text-[var(--brand)] hover:underline">
                      {chunks}
                    </a>
                  ),
                })}
              </p>
            </aside>
          </div>
        )}
      </main>

      <footer className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 pb-8 text-xs text-[var(--text-3)]">
        <span>{t('footer')}</span>
        <span className="flex gap-3">
          <a href={`${marketing}/impressum`} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {t('imprint')}
          </a>
          <a href={`${marketing}/datenschutz`} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {t('privacy')}
          </a>
          <a href={`${marketing}/agb`} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {t('terms')}
          </a>
        </span>
      </footer>
    </div>
  );
}

function Notice({
  title,
  body,
  action,
  tone = 'neutral',
}: {
  title: string;
  body: string;
  action: { href: string; label: string };
  tone?: 'neutral' | 'success';
}) {
  return (
    <div className="mx-auto max-w-md rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-[var(--shadow-sm)]">
      {tone === 'success' && (
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]">
          <Check size={18} />
        </div>
      )}
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-2)]">{body}</p>
      <Link href={action.href} className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-5 w-full')}>
        {action.label}
      </Link>
    </div>
  );
}

function TrustRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <Check />
      <span>{children}</span>
    </li>
  );
}

function Check({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="mt-[2px] shrink-0 text-[var(--success)]">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
