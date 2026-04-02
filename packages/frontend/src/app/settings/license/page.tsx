'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { license } from '@/lib/api';

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

  const isCloud = deploymentMode === 'cloud';

  useEffect(() => {
    loadStatus();
  }, [token]);

  const loadStatus = async () => {
    try {
      const data = await license.getStatus();
      setStatus(data);
    } catch {
      // ignore
    }
  };

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
      case 'active': return 'text-emerald-600';
      case 'expired': return 'text-amber-600';
      case 'invalid': case 'revoked': return 'text-red-600';
      case 'pending': return 'text-amber-500';
      default: return 'text-[var(--muted-foreground)]';
    }
  };

  if (user?.role !== 'ADMIN') {
    return (
      <div className="text-center py-12 text-[var(--muted-foreground)]">
        Only administrators can manage the license.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">License & Plan</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-1">
          Manage your Anything MCP license
        </p>
      </div>

      {/* Feedback */}
      {message && (
        <div className="p-3 rounded-md bg-emerald-50 text-emerald-700 text-sm border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
          {error}
        </div>
      )}

      {/* Current Plan */}
      <section className="border border-[var(--border)] rounded-lg p-5 bg-[var(--card)]">
        <h2 className="text-sm font-semibold mb-4">Current Plan</h2>

        {!status || !status.plan ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted-foreground)]">
              No license registered yet.
            </p>
            {isCloud ? (
              <button
                onClick={handleActivateTrial}
                disabled={loading}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
              >
                {loading ? 'Activating...' : 'Start 7-Day Free Trial'}
              </button>
            ) : (
              <button
                onClick={handleRegisterCommunity}
                disabled={loading}
                className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
              >
                {loading ? 'Registering...' : 'Register Free Community License'}
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[var(--muted-foreground)] text-xs mb-0.5">Plan</div>
              <div className="font-medium">{planLabel(status.plan)}</div>
            </div>
            <div>
              <div className="text-[var(--muted-foreground)] text-xs mb-0.5">Status</div>
              <div className={`font-medium capitalize ${statusColor(status.status)}`}>
                {status.status}
              </div>
            </div>
            <div>
              <div className="text-[var(--muted-foreground)] text-xs mb-0.5">Expires</div>
              <div>{formatDate(status.expiresAt)}</div>
            </div>
            <div>
              <div className="text-[var(--muted-foreground)] text-xs mb-0.5">Last Verified</div>
              <div>{formatDate(status.lastVerifiedAt)}</div>
            </div>
            {status.trialDaysLeft !== undefined && (
              <div>
                <div className="text-[var(--muted-foreground)] text-xs mb-0.5">Trial Days Left</div>
                <div className={`font-medium ${status.trialDaysLeft <= 2 ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {status.trialDaysLeft} days
                </div>
              </div>
            )}
            {!isCloud && (
              <div className="sm:col-span-2">
                <div className="text-[var(--muted-foreground)] text-xs mb-0.5">Instance ID</div>
                <div className="font-mono text-xs break-all">{status.instanceId || '—'}</div>
              </div>
            )}
          </div>
        )}

        {status?.plan && (
          <div className="mt-4 pt-4 border-t border-[var(--border)]">
            <button
              onClick={handleVerify}
              disabled={verifying}
              className="border border-[var(--border)] px-4 py-2 rounded-md text-sm font-medium hover:bg-[var(--accent)] disabled:opacity-50"
            >
              {verifying ? 'Verifying...' : 'Verify Now'}
            </button>
          </div>
        )}
      </section>

      {/* Features */}
      {status?.features && Object.keys(status.features).length > 0 && (
        <section className="border border-[var(--border)] rounded-lg p-5 bg-[var(--card)]">
          <h2 className="text-sm font-semibold mb-4">Features</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            {Object.entries(status.features).map(([key, value]) => (
              <div key={key} className="flex justify-between py-1">
                <span className="text-[var(--muted-foreground)]">
                  {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                </span>
                <span className="font-medium">
                  {value === true ? 'Yes' : value === false ? 'No' : value === null ? 'Unlimited' : String(value)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Change License Key */}
      {(!isCloud || status?.status === 'expired' || (status?.plan === 'trial' && status?.trialDaysLeft !== undefined && status?.trialDaysLeft <= 0)) && (
        <section className="border border-[var(--border)] rounded-lg p-5 bg-[var(--card)]">
          <h2 className="text-sm font-semibold mb-4">
            {status?.plan ? 'Change License Key' : 'Activate License Key'}
          </h2>
          <p className="text-sm text-[var(--muted-foreground)] mb-4">
            Purchase a license at{' '}
            <a
              href="https://anythingmcp.com/pricing"
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
              className="flex-1 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono tracking-wider"
            />
            <button
              onClick={handleActivate}
              disabled={loading || !licenseKey}
              className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? 'Activating...' : 'Activate'}
            </button>
          </div>
        </section>
      )}

      {/* Upgrade Plan (Cloud mode) */}
      {isCloud && status?.plan === 'trial' && (
        <section className="border border-[var(--border)] rounded-lg p-5 bg-[var(--card)]">
          <h2 className="text-sm font-semibold mb-4">Upgrade Plan</h2>
          <p className="text-sm text-[var(--muted-foreground)] mb-4">
            Upgrade to a paid plan to continue using AnythingMCP Cloud after your trial ends.
          </p>
          <a
            href="https://anythingmcp.com/pricing"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90"
          >
            View Plans
          </a>
        </section>
      )}
    </div>
  );
}
