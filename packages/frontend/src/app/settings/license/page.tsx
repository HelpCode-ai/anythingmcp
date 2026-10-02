'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
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
import { describeBilling } from '@/lib/billing-summary';

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
  const { token, user, deploymentMode } = useAuth();
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [licenseKey, setLicenseKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const managePlan = useManagePlan();
  const pricingUrl = usePricingUrl();
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
  const billingSummary = isCloud ? describeBilling(status?.billing) : null;
  const cardTrialDate = cardTrialOffer
    ? formatTrialEnd(cardTrialDisplayEnd(status?.expiresAt), 'long')
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
      setError(err.message || 'Failed to activate license');
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
        setMessage('License verified successfully');
      } else {
        setError(result.error || 'License is invalid');
      }
      await loadStatus();
      notifyEditionChanged();
    } catch (err: any) {
      setError(err.message || 'Verification failed');
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
      setError(err.message || 'Failed to register community license');
    } finally {
      setLoading(false);
    }
  };

  const handleBillingPortal = async (flow?: 'cancel') => {
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
      setError(err.message || 'Failed to open the billing portal');
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
      setError(err.message || 'Failed to activate trial');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const planLabel = (plan: string | null) => {
    if (!plan) return 'None';
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  };

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
        Only administrators can manage the license.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-base font-semibold text-[var(--text)]">License & Plan</h1>
        <p className="text-sm text-[var(--text-2)] mt-1">
          Manage your Anything MCP license
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
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">{isCloud ? 'Current Plan' : 'License key'}</h2>

        {!status || !status.plan ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-2)]">
              No license registered yet.
            </p>
            {isCloud ? (
              <Button onClick={handleActivateTrial} disabled={loading}>
                {loading ? 'Activating...' : 'Start 7-Day Free Trial'}
              </Button>
            ) : (
              <>
                <p className="text-xs text-[var(--text-3)]">
                  Optional for Community: a free key by email gets you security and release notices.
                </p>
                <Button variant="secondary" onClick={handleRegisterCommunity} disabled={loading}>
                  {loading ? 'Registering...' : 'Register Free Community License'}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">Plan</div>
              <div className="font-medium text-[var(--text)]">{planLabel(status.plan)}</div>
            </div>
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">Status</div>
              <div className={`font-medium capitalize ${statusColor(status.status)}`}>
                {status.status}
              </div>
            </div>
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">Expires</div>
              <div className="text-[var(--text)]">{formatDate(status.expiresAt)}</div>
            </div>
            <div>
              <div className="text-[var(--text-3)] text-xs mb-0.5">Last Verified</div>
              <div className="text-[var(--text)]">{formatDate(status.lastVerifiedAt)}</div>
            </div>
            {status.trialDaysLeft !== undefined && (
              <div>
                <div className="text-[var(--text-3)] text-xs mb-0.5">Trial Days Left</div>
                <div className={`font-medium ${status.trialDaysLeft <= 2 ? 'text-[var(--warn)]' : 'text-[var(--ok)]'}`}>
                  {status.trialDaysLeft} days
                </div>
              </div>
            )}
            {!isCloud && (
              <div className="sm:col-span-2">
                <div className="text-[var(--text-3)] text-xs mb-0.5">Instance ID</div>
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
              {verifying ? 'Verifying...' : 'Verify Now'}
            </Button>
            {hasBillableSubscription && (
              <Button onClick={() => handleBillingPortal()} disabled={openingPortal}>
                {openingPortal
                  ? 'Opening…'
                  : billingSummary?.paymentIssue
                    ? 'Update payment method'
                    : billingSummary?.cancelling
                      ? 'Keep my plan'
                      : 'Manage subscription & billing'}
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
                Cancel subscription
              </button>
            )}
          </div>
        )}
      </Card>

      {/* Features */}
      {isCloud && status?.features && Object.keys(status.features).length > 0 && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Features</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            {Object.entries(status.features).map(([key, value]) => (
              <div key={key} className="flex justify-between py-1">
                <span className="text-[var(--text-3)]">
                  {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                </span>
                <span className="font-medium text-[var(--text)]">
                  {value === true ? 'Yes' : value === false ? 'No' : value === null ? 'Unlimited' : String(value)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Change License Key — always available so admins can activate a purchased key any time */}
      <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">
            {status?.plan && status.plan !== 'trial' ? 'Change License Key' : 'Activate License Key'}
          </h2>
          {status?.plan && status.plan !== 'trial' ? (
            // A paying customer who buys again gets a second subscription beside
            // the first, not a new plan. Send them to the plan switch instead.
            <p className="text-sm text-[var(--text-2)] mb-4">
              To move to another plan,{' '}
              <a
                href={managePlan.href}
                onClick={managePlan.onClick}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--brand)] hover:underline font-medium"
              >
                change it in the billing portal
              </a>{' '}
              — your current subscription is switched and prorated, not duplicated.
            </p>
          ) : (
            <p className="text-sm text-[var(--text-2)] mb-4">
              Purchase a license at{' '}
              <a
                href={pricingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--brand)] hover:underline font-medium"
              >
                anythingmcp.com
              </a>
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
              {loading ? 'Activating...' : 'Activate'}
            </Button>
          </div>
        </Card>

      {/* Upgrade Plan (Cloud mode) */}
      {isCloud && status?.plan === 'trial' && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Upgrade Plan</h2>
          {cardTrialOffer ? (
            <>
              <p className="text-sm text-[var(--text-2)] mb-4">
                Add a payment method to keep AnythingMCP Cloud running after your trial. Nothing is
                charged before {cardTrialDate ?? 'your trial ends'}, and you can cancel anytime.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/start-trial" className={cn(buttonVariants({ variant: 'primary' }))}>
                  Add payment method
                </Link>
                <a
                  href={pricingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ variant: 'secondary' }))}
                >
                  Compare plans
                </a>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-[var(--text-2)] mb-4">
                Upgrade to a paid plan to continue using AnythingMCP Cloud after your trial ends.
              </p>
              <a
                href={pricingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'primary' }))}
              >
                View Plans
              </a>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
