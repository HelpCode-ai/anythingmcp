'use client';

import {
  CLOUD_PLANS,
  formatEur,
  formatPlanPrice,
  yearlyPerMonth,
  type BillingPeriod,
  type PlanSelection,
} from '@/lib/card-trial';
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
  const option = (p: BillingPeriod, label: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === p}
      disabled={disabled}
      onClick={() => onChange(p)}
      className={cn(
        'h-8 rounded-[7px] px-3 text-[12.5px] font-semibold transition-colors',
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
      aria-label="Billing period"
      className="inline-flex items-center gap-1 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-1"
    >
      {option('monthly', 'Monthly')}
      {option(
        'yearly',
        <>
          Yearly <span className="font-medium text-[var(--brand)]">· 2 months free</span>
        </>,
      )}
    </div>
  );
}

/**
 * The three Cloud plans with a billing-period switch, as a radio group.
 * `compact` lays the plans out as rows (for the licence wall's narrow modal).
 */
export function PlanPicker({
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  value: PlanSelection;
  onChange: (next: PlanSelection) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
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
        aria-label="Plan"
        className={cn('grid gap-3', compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-3')}
      >
        {CLOUD_PLANS.map((plan) => {
          const selected = value.plan === plan.id;
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
                  <span className="text-sm font-semibold text-[var(--text)]">{plan.name}</span>
                  {plan.popular && (
                    <span className="rounded-md bg-[var(--brand-tint)] px-1.5 py-[2px] text-[10.5px] font-semibold text-[var(--brand)]">
                      Most popular
                    </span>
                  )}
                </div>
                <p className={cn('text-xs text-[var(--text-2)]', compact ? 'mt-0.5 pl-6' : 'mt-2')}>
                  {plan.summary}
                </p>
              </div>
              <div className={cn(compact ? 'text-right flex-shrink-0' : 'mt-3')}>
                <div className="text-sm font-semibold text-[var(--text)] whitespace-nowrap">
                  {formatPlanPrice(plan, value.period)}
                </div>
                {value.period === 'yearly' && (
                  <div className="text-[11px] text-[var(--text-3)] whitespace-nowrap">
                    ≈ {formatEur(yearlyPerMonth(plan))}/month
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-center text-[11px] text-[var(--text-3)]">Prices in EUR, VAT included.</p>
    </div>
  );
}
