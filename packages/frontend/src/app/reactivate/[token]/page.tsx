'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { ApiError, reactivation, type ReactivationView } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useTrustStats } from '@/lib/trust-stats';
import { useLocalPricing } from '@/lib/local-currency';
import { CHATGPT_DIRECTORY_URL, CLAUDE_DIRECTORY_URL, buildEnterpriseContactUrl, getMarketingUrl } from '@/lib/marketing';
import {
  CLOUD_PLANS,
  DEFAULT_SELECTION,
  formatEur,
  limitsExceeded,
  planById,
  selectionForUsage,
  yearlyPerMonth,
  type PlanSelection,
} from '@/lib/card-trial';
import { LogoIcon } from '@/components/logo-icon';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { COPY, DATE_LOCALE, fmt, pickPageLang, splitTag, type PageLang, type ReactivateCopy } from './copy';

/** How often the page asks whether the payment reached the workspace, and for how long. */
const PAID_POLL_MS = 4000;
const PAID_POLL_LIMIT = 90;

/** Logos of the AI clients the page can name (public/logos/clients). */
const CLIENT_LOGOS: Record<string, string> = {
  Claude: 'claude',
  ChatGPT: 'chatgpt',
  Copilot: 'copilot',
  Cursor: 'cursor',
};
const WORKS_WITH = [
  { file: 'claude', label: 'Claude' },
  { file: 'chatgpt', label: 'ChatGPT' },
  { file: 'copilot', label: 'Copilot' },
  { file: 'cursor', label: 'Cursor' },
  { file: 'muse', label: 'Meta Muse' },
];

/**
 * The page an AI client links to when a tool call is refused because the
 * workspace's trial ended (A/B against the pricing page). No sign-in: the
 * token names the workspace, and the checkout it opens is for that workspace
 * alone, so the paid licence reaches it without anyone activating a key.
 * Back from Stripe (`?paid=1`) it waits until the workspace is active. The
 * words follow the visitor's language among the website's seven (copy.ts).
 */
export default function ReactivatePage() {
  // useSearchParams (the ?paid=1 return from Stripe) needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ReactivateContent />
    </Suspense>
  );
}

function usePageLang(): PageLang {
  const [lang, setLang] = useState<PageLang>('en');
  useEffect(() => {
    // Read after mount: the server render has no cookie or browser languages.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLang(pickPageLang(document.cookie, navigator.languages?.length ? navigator.languages : [navigator.language]));
  }, []);
  return lang;
}

function ReactivateContent() {
  const lang = usePageLang();
  const c = COPY[lang];
  const { token } = useParams<{ token: string }>();
  const searchParams = useSearchParams();
  const backFromStripe = searchParams.get('paid') === '1';
  const { token: session } = useAuth();
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
      setCheckoutError(e instanceof ApiError && e.status === 409 ? e.message : c.checkoutFailed);
      setOpening(false);
    }
  };

  const client = view?.client ?? null;
  const clientName = client ?? c.yourAi;
  const endedOn = view?.trialEndedAt
    ? new Date(view.trialEndedAt).toLocaleDateString(DATE_LOCALE[lang], { day: 'numeric', month: 'long', timeZone: 'UTC' })
    : null;
  // Each assistant's users see its own directory listing; anyone else both.
  const showClaude = client !== 'ChatGPT';
  const showChatgpt = client !== 'Claude';
  const selling = !!view && (view.state === 'trial-ended' || view.state === 'no-license') && !backFromStripe;

  return (
    <div lang={lang} className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
          <a href={marketing} className="flex shrink-0 items-center gap-2 font-semibold" target="_blank" rel="noopener noreferrer">
            <LogoIcon size={26} />
            <span>AnythingMCP</span>
          </a>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-xs text-[var(--text-2)] sm:inline-flex">
              <LockIcon />
              {c.nav.secureCheckout}
            </span>
            <Link
              href={session ? '/' : '/login?redirect=%2F'}
              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'whitespace-nowrap')}
            >
              {session ? c.nav.openWorkspace : c.nav.signIn}
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:py-12">
        {!view && !notFound && !loadError && (
          <p className="py-24 text-center text-sm text-[var(--text-3)]">{c.loading}</p>
        )}

        {(notFound || loadError) && (
          <Notice
            title={notFound ? c.expiredTitle : c.errorTitle}
            body={notFound ? c.expiredBody : c.errorBody}
            action={{ href: '/login', label: c.signIn }}
          />
        )}

        {view && view.state === 'active' && (
          <Notice
            tone="success"
            title={backFromStripe ? c.paidTitle : c.activeTitle}
            body={fmt(c.activeBody, { client: clientName, workspace: view.workspaceName })}
            action={{ href: '/', label: c.openDashboard }}
          />
        )}

        {view && view.state !== 'active' && backFromStripe && (
          <Notice
            title={c.processingTitle}
            body={pollsLeft > 0 ? c.processingBody : c.processingSlow}
            action={{ href: '/login', label: c.signIn }}
          />
        )}

        {view && view.state === 'payment-failed' && !backFromStripe && (
          <Notice title={c.paymentFailedTitle} body={c.paymentFailedBody} action={{ href: '/login', label: c.signIn }} />
        )}

        {selling && view && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-10">
            {/* On a phone the explanation goes below the plan card, so the
                subscribe button is on the first screen without scrolling. */}
            <section aria-labelledby="reactivate-title" className="flex flex-col">
              <div className="mb-3 flex flex-wrap gap-2">
                <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--text-2)]">
                  <span className="truncate">
                    {c.workspace}: <span className="font-medium text-[var(--text)]">{view.workspaceName}</span>
                  </span>
                </span>
                {client && (
                  <span
                    data-testid="client-paused"
                    className="hidden items-center sm:inline-flex gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--text-2)]"
                  >
                    {CLIENT_LOGOS[client] && (
                      <img src={`/logos/clients/${CLIENT_LOGOS[client]}.svg`} width={14} height={14} alt="" />
                    )}
                    {fmt(c.paused, { client })}
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]" aria-hidden />
                  </span>
                )}
              </div>
              <h1 id="reactivate-title" className="text-[28px] font-bold leading-tight tracking-tight sm:text-[34px]">
                {fmt(c.title, { client: clientName })}
              </h1>
              <p
                data-testid="reactivate-lead"
                className="order-last mt-5 text-[15px] leading-relaxed text-[var(--text-2)] sm:order-none sm:mt-3"
              >
                {endedOn ? fmt(c.bodyEnded, { date: endedOn, client: clientName }) : fmt(c.body, { client: clientName })}
              </p>

              <div className="mt-6 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-6">
                <PlanChooser copy={c} value={selection} onChange={pickPlan} disabled={opening} usage={view.usage} />
                <button
                  type="button"
                  onClick={subscribe}
                  disabled={opening}
                  className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'mt-5 w-full text-[15px]')}
                >
                  {opening ? c.opening : fmt(c.cta, { plan: planById(selection.plan).name })}
                </button>
                {checkoutError && (
                  <p role="alert" className="mt-2 text-center text-xs text-[var(--danger)]">
                    {checkoutError}
                  </p>
                )}
                <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-[var(--text-2)]">
                  {[c.chips.cancel, c.chips.stripe, c.chips.noSetup].map((item) => (
                    <li key={item} className="inline-flex items-center gap-1">
                      <Check />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <aside className="space-y-4">
              <div data-testid="reactivate-trust" className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                {(trust?.workspaces || trust?.toolCalls) && (
                  <div className="mb-4 grid grid-cols-2 gap-2.5">
                    {trust?.workspaces && <StatTile n={trust.workspaces} label={c.stats.workspaces} />}
                    {trust?.toolCalls && <StatTile n={trust.toolCalls} label={c.stats.toolCalls} />}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {showClaude && (
                    <a
                      href={CLAUDE_DIRECTORY_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(217,119,87,.45)] bg-[rgba(217,119,87,.08)] px-2.5 py-1 text-[12px] text-[var(--text)] hover:bg-[rgba(217,119,87,.14)]"
                    >
                      <img src="/logos/clients/claude.svg" width={13} height={13} alt="" />
                      {c.badges.claude}
                    </a>
                  )}
                  {showChatgpt && (
                    <a
                      href={CHATGPT_DIRECTORY_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(16,163,127,.45)] bg-[rgba(16,163,127,.08)] px-2.5 py-1 text-[12px] text-[var(--text)] hover:bg-[rgba(16,163,127,.14)]"
                    >
                      <img src="/logos/clients/chatgpt.svg" width={13} height={13} alt="" />
                      {c.badges.chatgpt}
                    </a>
                  )}
                  {[c.badges.eu, c.badges.gdpr, c.badges.encrypted, c.badges.openSource].map((b) => (
                    <span
                      key={b}
                      className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--text-2)]"
                    >
                      {b}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[var(--text-3)]">
                  <span>{c.worksWith}</span>
                  {WORKS_WITH.map((w) => (
                    <span key={w.file} className="inline-flex items-center gap-1.5 text-[var(--text-2)]">
                      <img src={`/logos/clients/${w.file}.svg`} width={16} height={16} alt="" />
                      {w.label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
                <h2 className="text-sm font-semibold">{c.next.title}</h2>
                <ol className="mt-4 space-y-4">
                  {[
                    { title: c.next.payTitle, body: c.next.payBody },
                    { title: c.next.activeTitle, body: c.next.activeBody },
                    { title: fmt(c.next.backTitle, { client: clientName }), body: c.next.backBody },
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
                <h2 className="text-sm font-semibold">{c.why.title}</h2>
                <ul className="mt-3 space-y-2.5 text-[13px] text-[var(--text-2)]">
                  <TrustRow>{c.why.kept}</TrustRow>
                  <TrustRow>{c.why.cancel}</TrustRow>
                  <TrustRow>
                    <Tagged text={c.why.support} tag="mail" href="mailto:support@anythingmcp.com" />
                  </TrustRow>
                </ul>
              </div>
            </aside>
          </div>
        )}
      </main>

      <footer className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 pb-8 text-xs text-[var(--text-3)]">
        <span>{c.footer}</span>
        <span className="flex gap-3">
          <a href={`${marketing}/impressum`} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {c.imprint}
          </a>
          <a href={`${marketing}/datenschutz`} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {c.privacy}
          </a>
          <a href={`${marketing}/agb`} target="_blank" rel="noopener noreferrer" className="hover:underline">
            {c.terms}
          </a>
        </span>
      </footer>
    </div>
  );
}

/**
 * The Cloud plans with the billing-period switch, in the page's language
 * (the dashboard's PlanPicker is English only). A plan the workspace has
 * outgrown says so.
 */
function PlanChooser({
  copy,
  value,
  onChange,
  disabled,
  usage,
}: {
  copy: ReactivateCopy;
  value: PlanSelection;
  onChange: (next: PlanSelection) => void;
  disabled: boolean;
  usage: ReactivationView['usage'];
}) {
  const p = copy.plans;
  const pricing = useLocalPricing(true);
  const footer = pricing?.currency
    ? fmt(p.pricesLocal, { currency: pricing.currency })
    : pricing?.vat === false
      ? p.pricesNoVat
      : p.pricesVat;
  const enterprise = useMemo(() => splitTag(p.enterprise, 'link'), [p.enterprise]);
  const period = (id: PlanSelection['period'], label: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={value.period === id}
      disabled={disabled}
      onClick={() => onChange({ ...value, period: id })}
      className={cn(
        'h-8 rounded-[7px] px-3 text-[12.5px] font-semibold transition-colors',
        value.period === id
          ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]'
          : 'text-[var(--text-2)] hover:text-[var(--text)]',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div
          role="radiogroup"
          aria-label={`${p.monthly} / ${p.yearly}`}
          className="inline-flex items-center gap-1 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-1"
        >
          {period('monthly', p.monthly)}
          {period(
            'yearly',
            <>
              {p.yearly} · <span className="text-[var(--brand)]">{p.twoMonthsFree}</span>
            </>,
          )}
        </div>
      </div>
      <div role="radiogroup" aria-label="Plan" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CLOUD_PLANS.map((plan) => {
          const selected = value.plan === plan.id;
          const outgrown = limitsExceeded(plan, usage).length > 0;
          const yearly = value.period === 'yearly';
          return (
            <button
              key={plan.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange({ ...value, plan: plan.id })}
              className={cn(
                // A phone gets name and price on one row, so the subscribe
                // button stays on the first screen.
                'grid grid-cols-[1fr_auto] items-center gap-x-3 rounded-[12px] border p-4 text-left transition-colors sm:block',
                selected
                  ? 'border-[var(--brand)] bg-[var(--brand-tint)] ring-1 ring-[var(--brand)]'
                  : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--text-3)]',
              )}
            >
              <span className="col-start-1 row-start-1 flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-full border',
                    selected ? 'border-[var(--brand)]' : 'border-[var(--text-3)]',
                  )}
                >
                  {selected && <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />}
                </span>
                <span className="font-semibold">{plan.name}</span>
                {plan.popular && <span className="text-[11px] font-semibold text-[var(--brand)]">{p.mostPopular}</span>}
              </span>
              <span className="col-span-2 mt-1.5 block text-xs text-[var(--text-2)] sm:mt-2">{plan.id === 'starter' ? p.starter : p.team}</span>
              {outgrown && <span className="col-span-2 mt-1 block text-xs text-[var(--warning-text)]">{p.outgrown}</span>}
              <span className="col-start-2 row-start-1 block whitespace-nowrap text-right sm:mt-3 sm:text-left">
                <span className="text-[17px] font-semibold">{formatEur(yearly ? plan.yearly : plan.monthly)}</span>
                <span className="text-sm text-[var(--text-2)]">{yearly ? p.perYear : p.perMonth}</span>
              </span>
              {yearly && (
                <span className="col-span-2 mt-0.5 block text-xs text-[var(--text-3)]">
                  {fmt(p.yearlyEquiv, { price: formatEur(yearlyPerMonth(plan)) })}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-center text-[11.5px] text-[var(--text-3)]">
        {footer}{' '}
        {enterprise && (
          <>
            {enterprise[0]}
            <a
              href={buildEnterpriseContactUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--brand)] hover:underline"
            >
              {enterprise[1]}
            </a>
            {enterprise[2]}
          </>
        )}
      </p>
    </div>
  );
}

function StatTile({ n, label }: { n: string; label: string }) {
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
      <div className="text-[19px] font-semibold tracking-tight">{n}</div>
      <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-2)]">{label}</div>
    </div>
  );
}

function Tagged({ text, tag, href }: { text: string; tag: string; href: string }) {
  const parts = splitTag(text, tag);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts[0]}
      <a href={href} className="text-[var(--brand)] hover:underline">
        {parts[1]}
      </a>
      {parts[2]}
    </>
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
