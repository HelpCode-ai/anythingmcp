'use client';

import { useLocale, useTranslations } from 'next-intl';
import {
  CLOUD_PLANS,
  formatEur,
  limitsExceeded,
  smallestFittingPlan,
  yearlyPerMonth,
  type BillingPeriod,
  type PlanSelection,
  type WorkspaceUsage,
} from '@/lib/card-trial';
import { buildEnterpriseContactUrl } from '@/lib/marketing';
import { useAuth } from '@/lib/auth-context';
import { formatLocal, useLocalPricing } from '@/lib/local-currency';
import { cn } from '@/lib/utils';

/** Monthly / yearly switch. Yearly is ten months' price for twelve. */
function PeriodToggle({
  value,
  onChange,
  disabled,
}: {
  value: BillingPeriod;
  onChange: (p: BillingPeriod) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('planPicker');
  const option = (p: BillingPeriod, label: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === p}
      disabled={disabled}
      onClick={() => onChange(p)}
      className={cn(
        'min-h-8 whitespace-nowrap rounded-[7px] px-3 py-1 text-[12.5px] font-semibold leading-tight transition-colors',
        value === p
          ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]'
          : 'text-[var(--text-2)] hover:text-[var(--text)]',
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="radiogroup"
      aria-label={t('periodLabel')}
      className="inline-flex items-center gap-1 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-1"
    >
      {option('monthly', t('monthly'))}
      {option(
        'yearly',
        <>
          {t('yearly')}{' '}
          {/* Under 360 px the saving goes on a line of its own instead of breaking in the middle. */}
          <span className="font-medium text-[var(--brand)] max-[359px]:block max-[359px]:text-[11px]">
            <span className="max-[359px]:hidden">· </span>
            {t('twoMonthsFree')}
          </span>
        </>,
      )}
    </div>
  );
}

/**
 * The self-service Cloud plans with a billing-period switch, as a radio group,
 * and a line to Enterprise for anything beyond them. `compact` lays the plans
 * out as rows (for the licence wall's narrow modal). With `usage` (what the
 * workspace already has), a plan it has outgrown says so under its summary.
 * What a plan changes for this workspace ("What changes with Starter") is
 * shown by the caller under its subscribe button (PlanFitNotice).
 */
export function PlanPicker({
  value,
  onChange,
  compact = false,
  disabled = false,
  usage = null,
}: {
  value: PlanSelection;
  onChange: (next: PlanSelection) => void;
  compact?: boolean;
  disabled?: boolean;
  usage?: WorkspaceUsage | null;
}) {
  const { deploymentMode } = useAuth();
  const t = useTranslations('planPicker');
  // Amounts in the UI language ("15,83 €" in German and Italian).
  const locale = useLocale();
  const eur = (amount: number) => formatEur(amount, locale);
  // Outside the euro area Stripe charges in the visitor's currency: lead with
  // that estimate and keep the exact euro price under it, as the pricing page
  // does. Outside the EU no VAT is charged.
  const pricing = useLocalPricing(deploymentMode === 'cloud');
  const footer = pricing?.currency
    ? t(pricing.vat === false ? 'footer.local' : 'footer.localVat', { currency: pricing.currency })
    : pricing?.vat === false
      ? t('footer.noVat')
      : t('footer.vat');
  // Past Team too: Enterprise is the plan that fits.
  const outgrewAll = !!usage && smallestFittingPlan(usage) === null;
  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <PeriodToggle
          value={value.period}
          onChange={(period) => onChange({ ...value, period })}
          disabled={disabled}
        />
      </div>

      <div
        role="radiogroup"
        aria-label={t('planLabel')}
        className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2')}
      >
        {CLOUD_PLANS.map((plan) => {
          const selected = value.plan === plan.id;
          const local = formatLocal(value.period === 'yearly' ? plan.yearly : plan.monthly, pricing);
          const exceeded = usage ? limitsExceeded(plan, usage) : [];
          const summary = t('summary', { ...plan.limits }).split(' · ');
          const exact = t('price', {
            amount: eur(value.period === 'yearly' ? plan.yearly : plan.monthly),
            period: value.period,
          });
          return (
            <button
              key={plan.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange({ ...value, plan: plan.id })}
              className={cn(
                'relative rounded-[12px] border bg-[var(--surface)] text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-ring)]',
                compact ? 'flex items-center justify-between gap-3 px-4 py-3' : 'p-4',
                selected
                  ? 'border-[var(--brand)] bg-[var(--brand-tint)]'
                  : 'border-[var(--border)] hover:border-[var(--border-strong)]',
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border',
                      selected ? 'border-[var(--brand)]' : 'border-[var(--border-strong)]',
                    )}
                  >
                    {selected && <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />}
                  </span>
                  {/* On a narrow screen the badge goes under the name, never in two lines. */}
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold text-[var(--text)]">{plan.name}</span>
                    {plan.popular && (
                      <span className="whitespace-nowrap rounded-md bg-[var(--brand-tint)] px-1.5 py-[2px] text-[10.5px] font-semibold text-[var(--brand)]">
                        {t('mostPopular')}
                      </span>
                    )}
                  </span>
                </div>
                <p className={cn('text-xs text-[var(--text-2)]', compact ? 'mt-0.5 pl-6' : 'mt-2')}>
                  {/* Each limit stays whole: a line breaks between them, not inside "MCP-Server". */}
                  {summary.map((item, i) => (
                    <span key={item}>
                      {i > 0 && ' '}
                      <span className="whitespace-nowrap">
                        {item}
                        {i < summary.length - 1 && ' ·'}
                      </span>
                    </span>
                  ))}
                </p>
                {exceeded.length > 0 && usage && (
                  <p className={cn('text-xs text-[var(--warning-text)]', compact ? 'mt-0.5 pl-6' : 'mt-1')}>
                    {t('outgrown', {
                      items: exceeded.map((k) => t(`usage.${k}`, { count: usage[k] })).join(t('listSeparator')),
                    })}
                  </p>
                )}
              </div>
              <div className={cn(compact ? 'text-right flex-shrink-0' : 'mt-3')}>
                <div className="text-sm font-semibold text-[var(--text)] whitespace-nowrap">
                  {local ? t('priceLocal', { amount: local, period: value.period }) : exact}
                </div>
                {local ? (
                  <div className="text-[11px] text-[var(--text-3)] whitespace-nowrap">
                    {t('exactly', { price: exact })}
                  </div>
                ) : (
                  value.period === 'yearly' && (
                    <div className="text-[11px] text-[var(--text-3)] whitespace-nowrap">
                      {t('yearlyPerMonth', { amount: eur(yearlyPerMonth(plan)) })}
                    </div>
                  )
                )}
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-center text-[11px] text-[var(--text-3)]">
        {footer}{' '}
        {/* The question and its link move to the next line together. */}
        <span className="inline-block">
          {outgrewAll ? t('pastTeam') : t('enterpriseQuestion')}{' '}
          <a
            href={buildEnterpriseContactUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="whitespace-nowrap text-[var(--brand)] hover:underline"
          >
            {t('enterpriseLink')}
          </a>
        </span>
      </p>
    </div>
  );
}
