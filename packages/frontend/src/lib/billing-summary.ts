import type { LicenseBilling } from './api';

/**
 * One plain sentence about a paid Cloud subscription, for the licence page and
 * the app banner: when a card trial turns into a charge, when a cancelled plan
 * stops, when it renews, or that a payment failed. Null when there is nothing
 * worth saying (no subscription data).
 */
export interface BillingSummary {
  tone: 'info' | 'warn' | 'danger' | 'neutral';
  /** What the banner/page says. */
  text: string;
  /** The subscription is set to end (show "keep my plan", not "cancel"). */
  cancelling: boolean;
  /** Payment is failing (show "update payment method"). */
  paymentIssue: boolean;
}

function formatDate(iso: string | null, locale?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatAmount(
  amount: number | null,
  currency: string | null,
  locale?: string,
): string | null {
  if (amount == null || !currency) return null;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(
      amount / 100,
    );
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function per(interval: LicenseBilling['interval']): string {
  return interval ? `/${interval}` : '';
}

export function describeBilling(
  billing: LicenseBilling | null | undefined,
  locale?: string,
): BillingSummary | null {
  if (!billing) return null;
  const price = formatAmount(billing.amount, billing.currency, locale);
  const priceText = price ? `${price}${per(billing.interval)}` : null;

  if (billing.status === 'past_due' || billing.status === 'unpaid') {
    return {
      tone: 'danger',
      text: 'Your last payment failed. Update your payment method to keep your plan.',
      cancelling: billing.cancelling,
      paymentIssue: true,
    };
  }

  if (billing.cancelling) {
    const end = formatDate(billing.endsAt ?? billing.currentPeriodEnd, locale);
    return {
      tone: 'warn',
      text:
        billing.status === 'trialing'
          ? `Your trial is cancelled — you won't be charged.${end ? ` Your plan stays active until ${end}.` : ''}`
          : `Your subscription is cancelled${end ? ` and ends on ${end}` : ''}. Changed your mind? You can keep your plan.`,
      cancelling: true,
      paymentIssue: false,
    };
  }

  if (billing.status === 'trialing') {
    const end = formatDate(billing.trialEnd, locale);
    return {
      tone: 'info',
      text: `Free trial${end ? ` until ${end}` : ''}${priceText ? `, then ${priceText}` : ''}. Cancel any time before then and you pay nothing.`,
      cancelling: false,
      paymentIssue: false,
    };
  }

  const renews = formatDate(billing.currentPeriodEnd, locale);
  if (!renews) return null;
  return {
    tone: 'neutral',
    text: `Renews on ${renews}${priceText ? ` for ${priceText}` : ''}.`,
    cancelling: false,
    paymentIssue: false,
  };
}
