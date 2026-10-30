'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { license, type LicenseBilling } from '@/lib/api';
import { usePricingUrl } from '@/lib/use-pricing-url';
import { useManagePlan } from '@/lib/use-manage-plan';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useEdition, notifyEditionChanged } from '@/lib/use-edition';
import { EditionCard } from '@/components/edition-card';
import { cardTrialDisplayEnd, cardTrialEligible, formatTrialEnd } from '@/lib/card-trial';
import { useCardTrialKind } from '@/lib/use-card-trial-eligibility';
import { describeBilling } from '@/lib/billing-summary';
import { licensePageSource, startTrialPath } from '@/lib/checkout-source';

interface LicenseStatus {
  plan: string | null;
  status: string;
  features: Record<string, any> | null;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  instanceId: string | null;
  trialDaysLeft?: number;
  billing?: LicenseBilling;
}

export default function LicenseSettingsPage() {
  const t = useTranslations('settingsLicense');
  const locale = useLocale();
  // English keeps the en-GB day-month order formatTrialEnd has always used.
  const dateLocale = locale === 'en' ? 'en-GB' : locale;
  const { token, user, deploymentMode } = useAuth();
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [licenseKey, setLicenseKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const managePlan = useManagePlan();
  // Where the visitor came from (`?source=`, e.g. the offer email), passed on
  // to the card trial and the pricing link for Stripe metadata.
  const [source, setSource] = useState<ReturnType<typeof licensePageSource>>('license_page');
  useEffect(() => {
    setSource(licensePageSource(new URLSearchParams(window.location.search).get('source')));
  }, []);
  const pricingUrl = usePricingUrl(undefined, source);
  const { edition } = useEdition();

  const isCloud = deploymentMode === 'cloud';
  // The Stripe billing portal only applies to a real paid subscription —
  // not the free trial or a self-hosted community license.
  const hasBillableSubscription =
    isCloud &&
    !!status?.plan &&
    status.plan !== 'trial' &&
    status.plan !== 'community';
  // Cloud admin on a running free trial: offer the card trial (/start-trial).
  const cardTrialOffer = cardTrialEligible({ isCloud, role: user?.role, license: status });
  const cardTrialKind = useCardTrialKind(token, cardTrialOffer);
  const billingSummary = isCloud ? describeBilling(status?.billing) : null;
  const cardTrialDate = cardTrialOffer
    ? formatTrialEnd(cardTrialDisplayEnd(status?.expiresAt), 'long', undefined, dateLocale)
    : null;

  const loadStatus = async () => {
    try {
      const data = await license.getStatus(token || undefined);
      setStatus(data);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadStatus();
    // Cloud admins land here from the billing portal and from Checkout: ask the
    // server to re-verify now, so a cancellation, plan change or new card
    // trial shows immediately instead of after the daily re-verification.
    // The server throttles this to once a minute per workspace.
    if (token && isCloud && user?.role === 'ADMIN') {
      license
        .refresh(token)
        .then((r) => (r.refreshed ? loadStatus() : undefined))
        .catch(() => {});
    }
  }, [token, isCloud, user?.role]);

  const handleActivate = async () => {
    if (!token || !licenseKey) return;
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const result = await license.setKey(licenseKey, token);
      setMessage(result.message);
      setLicenseKey('');
      await loadStatus();
      notifyEditionChanged();
    } catch (err: any) {
      setError(err.message || t('errors.activate'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!token) return;
    setError('');
    setMessage('');
    setVerifying(true);
    try {
      const result = await license.verify(token);
      if (result.valid) {
        setMessage(t('verified'));
      } else {
        setError(result.error || t('errors.invalid'));
      }
      await loadStatus();
      notifyEditionChanged();
    } catch (err: any) {
      setError(err.message || t('errors.verify'));
    } finally {
      setVerifying(false);
    }
  };

  const handleRegisterCommunity = async () => {
    if (!token) return;
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const result = await license.registerCommunity(token);
      setMessage(result.message);
      await loadStatus();
    } catch (err: any) {
      setError(err.message || t('errors.register'));
    } finally {
      setLoading(false);
    }
  };

  const handleBillingPortal = async (flow?: 'cancel' | 'payment_method_update') => {
    if (!token) return;
    setError('');
    setMessage('');
    setOpeningPortal(true);
    try {
      const { url } = await license.billingPortal(
        token,
        typeof window !== 'undefined' ? window.location.href : undefined,
        flow,
      );
      window.location.href = url;
    } catch (err: any) {
      setError(err.message || t('errors.portal'));
      setOpeningPortal(false);
    }
  };

  const handleActivateTrial = async () => {
    if (!token) return;
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const result = await license.activateTrial(token);
      setMessage(result.message);
      await loadStatus();
    } catch (err: any) {
      setError(err.message || t('errors.trial'));
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const planLabel = (plan: string | null) => {
    if (!plan) return t('none');
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  };

  // Unknown statuses from the server are shown as they come.
  const statusLabel = (s: string) => (t.has(`statuses.${s}`) ? t(`statuses.${s}`) : s);

  const statusColor = (s: string) => {
    switch (s) {
      case 'active': return 'text-[var(--ok)]';
      case 'expired': return 'text-[var(--warn)]';
      case 'invalid': case 'revoked': return 'text-[var(--danger)]';
      case 'pending': return 'text-[var(--warn)]';
      default: return 'text-[var(--text-3)]';
    }
  };

  if (user?.role !== 'ADMIN') {
    return (
      <div className="text-center py-12 text-[var(--text-3)]">
        {t('adminOnly')}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-base font-semibold text-[var(--text)]">{t('title')}</h1>
        <p className="text-sm text-[var(--text-2)] mt-1">
          {t('intro')}
        </p>
      </div>

      {/* Feedback */}
      {message && (
        <div className="p-3 rounded-[9px] text-sm" style={{ background: 'var(--t-success-bg)', color: 'var(--t-success-fg)' }}>
          {message}
        </div>
      )}
      {error && (
        <div className="p-3 rounded-[9px] text-sm" style={{ background: 'var(--t-danger-bg)', color: 'var(--t-danger-fg)' }}>
          {error}
        </div>
      )}

      {edition && <EditionCard edition={edition} />}

      {/* Current Plan */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">{isCloud ? t('currentPlan') : t('licenseKey')}</h2>

        {!status || !status.plan ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-2)]">
              {t('noLicense')}
            </p>
            {isCloud ? (
              <Button onClick={handleActivateTrial} disabled={loading}>
                {loading ? t('activating') : t('startTrial')}
              </Button>
            ) : (
              <>
                <p className="text-xs text-[var(--text-3)]">
                  {t('communityHint')}
                </p>
                <Button variant="secondary" onClick={handleRegisterCommunity} disabled={loading}>
                  {loading ? t('registering') : t('registerCommunity')}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">{t('fields.plan')}</div>
              <div className="font-medium text-[var(--text)]">{planLabel(status.plan)}</div>
            </div>
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">{t('fields.status')}</div>
              <div className={`font-medium capitalize ${statusColor(status.status)}`}>
                {statusLabel(status.status)}
              </div>
            </div>
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">{t('fields.expires')}</div>
              <div className="text-[var(--text)]">{formatDate(status.expiresAt)}</div>
            </div>
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">{t('fields.lastVerified')}</div>
              <div className="text-[var(--text)]">{formatDate(status.lastVerifiedAt)}</div>
            </div>
            {status.trialDaysLeft !== undefined && (
              <div>
                <div className="text-[var(--text-3)] text-xs mb-0.5">{t('fields.trialDaysLeft')}</div>
                <div className={`font-medium ${status.trialDaysLeft <= 2 ? 'text-[var(--warn)]' : 'text-[var(--ok)]'}`}>
                  {t('fields.days', { count: status.trialDaysLeft })}
                </div>
              </div>
            )}
            {!isCloud && (
              <div className="sm:col-span-2">
                <div className="text-[var(--text-3)] text-xs mb-0.5">{t('fields.instanceId')}</div>
                <div className="font-mono text-xs break-all text-[var(--text)]">{status.instanceId || '—'}</div>
              </div>
            )}
          </div>
        )}

        {billingSummary && (
          <div
            role="status"
            className="mt-4 rounded-[9px] p-3 text-sm"
            style={{
              background:
                billingSummary.tone === 'danger'
                  ? 'var(--t-danger-bg)'
                  : billingSummary.tone === 'warn'
                    ? 'var(--t-warn-bg)'
                    : billingSummary.tone === 'info'
                      ? 'var(--t-info-bg)'
                      : 'var(--surface-2)',
              color:
                billingSummary.tone === 'danger'
                  ? 'var(--t-danger-fg)'
                  : billingSummary.tone === 'warn'
                    ? 'var(--t-warn-fg)'
                    : billingSummary.tone === 'info'
                      ? 'var(--t-info-fg)'
                      : 'var(--text-2)',
            }}
          >
            {billingSummary.text}
          </div>
        )}

        {status?.plan && (
          <div className="mt-4 pt-4 border-t border-[var(--border)] flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={handleVerify} disabled={verifying}>
              {verifying ? t('verifying') : t('verify')}
            </Button>
            {hasBillableSubscription && (
              <Button
                // A declined card is fixed on Stripe's add-a-card page, which
                // also pays the open invoice; the portal home hides it.
                onClick={() => handleBillingPortal(billingSummary?.paymentIssue ? 'payment_method_update' : undefined)}
                disabled={openingPortal}
              >
                {openingPortal
                  ? t('billing.opening')
                  : billingSummary?.paymentIssue
                    ? t('billing.updatePayment')
                    : billingSummary?.cancelling
                      ? t('billing.keepPlan')
                      : t('billing.manage')}
              </Button>
            )}
            {/* A clearly labelled way out, in the app itself: opens Stripe's
                cancellation page directly. Hidden once the plan is already set
                to end ("Keep my plan" above undoes that). */}
            {hasBillableSubscription && !billingSummary?.cancelling && (
              <button
                type="button"
                onClick={() => handleBillingPortal('cancel')}
                disabled={openingPortal}
                className="text-sm text-[var(--text-3)] underline underline-offset-2 hover:text-[var(--text-2)] disabled:opacity-50"
              >
                {t('billing.cancel')}
              </button>
            )}
          </div>
        )}
      </Card>

      {/* Features */}
      {isCloud && status?.features && Object.keys(status.features).length > 0 && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">{t('features.title')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            {Object.entries(status.features).map(([key, value]) => (
              <div key={key} className="flex justify-between py-1">
                <span className="text-[var(--text-3)]">
                  {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                </span>
                <span className="font-medium text-[var(--text)]">
                  {value === true ? t('features.yes') : value === false ? t('features.no') : value === null ? t('features.unlimited') : String(value)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Change License Key — always available so admins can activate a purchased key any time */}
      <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">
            {status?.plan && status.plan !== 'trial' ? t('key.change') : t('key.activate')}
          </h2>
          {status?.plan && status.plan !== 'trial' ? (
            // A paying customer who buys again gets a second subscription beside
            // the first, not a new plan. Send them to the plan switch instead.
            <p className="text-sm text-[var(--text-2)] mb-4">
              {t.rich('key.changePlan', {
                link: (chunks) => (
                  <a
                    href={managePlan.href}
                    onClick={managePlan.onClick}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--brand)] hover:underline font-medium"
                  >
                    {chunks}
                  </a>
                ),
              })}
            </p>
          ) : (
            <p className="text-sm text-[var(--text-2)] mb-4">
              {t.rich('key.purchase', {
                link: (chunks) => (
                  <a
                    href={pricingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--brand)] hover:underline font-medium"
                  >
                    {chunks}
                  </a>
                ),
              })}
            </p>
          )}

          <div className="flex gap-3">
            <input
              type="text"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
              placeholder="AMCP-XXXX-XXXX-XXXX-XXXX"
              className="flex-1 h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] font-mono tracking-wider outline-none focus:border-[var(--brand)]"
            />
            <Button onClick={handleActivate} disabled={loading || !licenseKey}>
              {loading ? t('activating') : t('key.submit')}
            </Button>
          </div>
        </Card>

      {/* Upgrade Plan (Cloud mode) */}
      {isCloud && status?.plan === 'trial' && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">{t('upgrade.title')}</h2>
          {cardTrialOffer ? (
            <>
              {cardTrialKind === 'pay' ? (
                <p className="text-sm text-[var(--text-2)] mb-4">
                  {t('upgrade.payBody')}
                </p>
              ) : (
                <p className="text-sm text-[var(--text-2)] mb-4">
                  {cardTrialDate ? t('upgrade.cardBody', { date: cardTrialDate }) : t('upgrade.cardBodyNoDate')}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <Link href={startTrialPath(source)} className={cn(buttonVariants({ variant: 'primary' }))}>
                  {cardTrialKind === 'pay' ? t('upgrade.choosePlan') : t('upgrade.addPayment')}
                </Link>
                <a
                  href={pricingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ variant: 'secondary' }))}
                >
                  {t('upgrade.compare')}
                </a>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-[var(--text-2)] mb-4">
                {t('upgrade.body')}
              </p>
              <a
                href={pricingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'primary' }))}
              >
                {t('upgrade.viewPlans')}
              </a>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
