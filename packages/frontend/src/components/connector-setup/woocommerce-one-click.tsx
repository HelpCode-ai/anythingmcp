'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type WooCommerceScope = 'read' | 'read_write';

/**
 * "Connect with one click" on the WooCommerce setup: the merchant approves a
 * REST API key on their own shop (WooCommerce's /wc-auth/v1/authorize) and the
 * shop sends it to AnythingMCP. Shown only when the server offers it
 * (GET /api/woocommerce/one-click); the paste fields stay below as the fallback.
 */
export function WooCommerceOneClick({
  scope,
  onScope,
  onConnect,
  disabled,
  checking,
}: {
  scope: WooCommerceScope;
  onScope: (scope: WooCommerceScope) => void;
  onConnect: () => void;
  disabled: boolean;
  /** Back from the shop: the key is being checked. */
  checking: boolean;
}) {
  const t = useTranslations('connectorSetup.wooOneClick');
  if (checking) {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-[11px] bg-[var(--t-info-bg)] px-4 py-3 text-sm text-[var(--t-info-fg)]">
        <span aria-hidden className="size-2.5 flex-none animate-pulse rounded-full bg-current" />
        {t('checking')}
      </div>
    );
  }
  const options: Array<{ value: WooCommerceScope; label: string; hint: string }> = [
    { value: 'read', label: t('read'), hint: t('readHint') },
    { value: 'read_write', label: t('readWrite'), hint: t('readWriteHint') },
  ];
  return (
    <div className="space-y-3 rounded-[11px] border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div>
        <p className="text-sm font-medium text-[var(--text)]">{t('title')}</p>
        <p className="mt-1 text-sm text-[var(--text-2)]">{t('body')}</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="sr-only">{t('scopeLegend')}</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded-[9px] border px-3 py-2 text-sm',
              scope === o.value ? 'border-[var(--border-strong)] bg-[var(--surface)]' : 'border-[var(--border)]',
            )}
          >
            <input
              type="radio"
              name="woocommerce-scope"
              value={o.value}
              checked={scope === o.value}
              onChange={() => onScope(o.value)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-[var(--text)]">{o.label}</span>
              <span className="block text-xs text-[var(--text-3)]">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button onClick={onConnect} disabled={disabled}>
        {t('connect')}
      </Button>
      <p className="text-xs text-[var(--text-3)]">{t('orPaste')}</p>
    </div>
  );
}
