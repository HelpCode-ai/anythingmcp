'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { license } from '@/lib/api';
import { buildPricingUrl } from '@/lib/marketing';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface LicenseStatus {
  plan: string | null;
  status: string;
  features: Record<string, any> | null;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  instanceId: string | null;
  trialDaysLeft?: number;
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

  const isCloud = deploymentMode === 'cloud';
  // The Stripe billing portal only applies to a real paid subscription —
  // not the free trial or a self-hosted community license.
  const hasBillableSubscription =
    isCloud &&
    !!status?.plan &&
    status.plan !== 'trial' &&
    status.plan !== 'community';

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
  }, [token]);

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

  const handleBillingPortal = async () => {
    if (!token) return;
    setError('');
    setMessage('');
    setOpeningPortal(true);
    try {
      const { url } = await license.billingPortal(
        token,
        typeof window !== 'undefined' ? window.location.href : undefined,
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

      {/* Current Plan */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Current Plan</h2>

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
              <Button onClick={handleRegisterCommunity} disabled={loading}>
                {loading ? 'Registering...' : 'Register Free Community License'}
              </Button>
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

        {status?.plan && (
          <div className="mt-4 pt-4 border-t border-[var(--border)] flex flex-wrap gap-3">
            <Button variant="secondary" onClick={handleVerify} disabled={verifying}>
              {verifying ? 'Verifying...' : 'Verify Now'}
            </Button>
            {hasBillableSubscription && (
              <Button onClick={handleBillingPortal} disabled={openingPortal}>
                {openingPortal ? 'Opening…' : 'Manage subscription & billing'}
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* Features */}
      {status?.features && Object.keys(status.features).length > 0 && (
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
          <p className="text-sm text-[var(--text-2)] mb-4">
            Purchase a license at{' '}
            <a
              href={buildPricingUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--brand)] hover:underline font-medium"
            >
              anythingmcp.com
            </a>
          </p>

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
          <p className="text-sm text-[var(--text-2)] mb-4">
            Upgrade to a paid plan to continue using AnythingMCP Cloud after your trial ends.
          </p>
          <a
            href={buildPricingUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: 'primary' }))}
          >
            View Plans
          </a>
        </Card>
      )}
    </div>
  );
}
