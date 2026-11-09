'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { license, type InvoiceEmailSettings } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * Settings → License (Cloud, admins with a subscription): email each paid
 * invoice as a PDF, to the billing contact or to another address. The licence
 * site sends the emails; this card only reads and changes the setting.
 * Hidden when the workspace has no subscription to send invoices for.
 */
export function InvoiceEmailCard({ token }: { token: string }) {
  const t = useTranslations('settingsLicense.invoiceEmail');
  const locale = useLocale();
  const [settings, setSettings] = useState<InvoiceEmailSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [mode, setMode] = useState<'billing' | 'custom'>('billing');
  const [address, setAddress] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const switchLabel = useId();
  const addressId = useId();

  const apply = (next: InvoiceEmailSettings) => {
    setSettings(next);
    setMode(next.recipient.kind);
    setAddress(next.recipient.kind === 'custom' ? (next.recipient.address ?? '') : '');
  };

  useEffect(() => {
    let alive = true;
    license
      .invoiceEmail(token)
      .then((s) => alive && apply(s))
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
  }, [token]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  if (loadFailed) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-2">{t('title')}</h2>
        <p className="text-sm text-[var(--text-2)]">{t('loadError')}</p>
      </Card>
    );
  }
  if (!settings || !settings.available) return null;

  const save = async (change: { enabled: boolean; to?: string | null }, done: string) => {
    setError('');
    setSaved('');
    setSaving(true);
    try {
      apply(await license.setInvoiceEmail(token, change));
      setSaved(done);
    } catch (err: any) {
      setError(err?.message || t('saveError'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = () => {
    const enabled = !settings.enabled;
    void save({ enabled }, enabled ? t('savedOn') : t('savedOff'));
  };

  const saveRecipient = () => {
    if (mode === 'billing') {
      void save({ enabled: settings.enabled, to: null }, t('savedRecipient'));
      return;
    }
    const value = address.trim();
    if (!value || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) {
      setSaved('');
      setError(t('invalidAddress'));
      return;
    }
    void save({ enabled: settings.enabled, to: value }, t('savedRecipient'));
  };

  const currentCustom = settings.recipient.kind === 'custom' ? settings.recipient.address : null;
  const recipientChanged =
    mode === 'billing' ? settings.recipient.kind !== 'billing' : address.trim().toLowerCase() !== (currentCustom ?? '');
  const lastSentDate = settings.lastSent
    ? new Date(settings.lastSent.at).toLocaleDateString(locale === 'en' ? 'en-GB' : locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  return (
    <Card className="p-5" data-testid="invoice-email-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={switchLabel} className="text-sm font-semibold text-[var(--text)]">
            {t('title')}
          </h2>
          <p className="text-sm text-[var(--text-2)] mt-1">{t('body')}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          aria-labelledby={switchLabel}
          onClick={toggle}
          disabled={saving}
          data-testid="invoice-email-switch"
          className={`relative mt-0.5 inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
            settings.enabled ? 'bg-[var(--brand)]' : 'bg-[var(--border-strong)]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              settings.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {settings.enabled && (
        <fieldset className="mt-4 pt-4 border-t border-[var(--border)]" disabled={saving}>
          <legend className="text-xs font-medium text-[var(--text-3)] mb-2">{t('recipientLabel')}</legend>
          <label className="flex items-center gap-2 text-sm text-[var(--text)] py-1">
            <input
              type="radio"
              name="invoice-recipient"
              checked={mode === 'billing'}
              onChange={() => setMode('billing')}
            />
            <span>
              {t('billingContact')}
              {settings.billingContact && (
                <span className="text-[var(--text-2)]"> ({settings.billingContact})</span>
              )}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--text)] py-1">
            <input type="radio" name="invoice-recipient" checked={mode === 'custom'} onChange={() => setMode('custom')} />
            <span>{t('otherAddress')}</span>
          </label>
          {mode === 'custom' && (
            <div className="mt-2 ml-6">
              <label htmlFor={addressId} className="sr-only">
                {t('otherAddress')}
              </label>
              <input
                id={addressId}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveRecipient()}
                placeholder={t('addressPlaceholder')}
                data-testid="invoice-email-address"
                className="w-full max-w-sm h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
              />
              <p className="text-xs text-[var(--text-3)] mt-1">{t('otherAddressHint')}</p>
            </div>
          )}
          {recipientChanged && (
            <div className="mt-3">
              <Button variant="secondary" onClick={saveRecipient} disabled={saving}>
                {saving ? t('saving') : t('saveRecipient')}
              </Button>
            </div>
          )}
        </fieldset>
      )}

      {settings.enabled && settings.lastSent && (
        <p className="text-xs text-[var(--text-3)] mt-4" data-testid="invoice-email-last-sent">
          {t('lastSent', { number: settings.lastSent.number, date: lastSentDate ?? '', to: settings.lastSent.to })}
        </p>
      )}
      <p className="text-xs text-[var(--text-3)] mt-3">{t('allInvoices')}</p>

      <div aria-live="polite">
        {saved && <p className="text-sm text-[var(--t-success-fg,var(--text-2))] mt-3">{saved}</p>}
      </div>
      {error && (
        <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-[var(--t-danger-fg)] mt-3 outline-none">
          {error}
        </p>
      )}
    </Card>
  );
}
