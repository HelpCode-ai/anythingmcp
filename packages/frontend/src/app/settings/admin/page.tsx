'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { adminSettings, type AlertWebhookInput } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AppSelect } from '@/components/ui/select';
import { copyText } from '@/lib/clipboard';

const ALERT_WEBHOOK_TYPE_OPTIONS = [
  { value: 'json', label: 'Generic JSON webhook' },
  { value: 'slack', label: 'Slack incoming webhook' },
];

export default function SettingsAdminPage() {
  const { token, user, deploymentMode } = useAuth();
  const isCloud = deploymentMode === 'cloud';

  // SMTP
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [smtpMsg, setSmtpMsg] = useState('');

  // Footer links
  const [footerLinks, setFooterLinks] = useState<Array<{ label: string; url: string }>>([]);
  const [footerMsg, setFooterMsg] = useState('');

  // Connector-failure alert webhook
  const [alertUrl, setAlertUrl] = useState('');
  const [alertType, setAlertType] = useState<'json' | 'slack'>('json');
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [alertThreshold, setAlertThreshold] = useState(5);
  const [alertWindowMinutes, setAlertWindowMinutes] = useState(10);
  const [alertCooldownMinutes, setAlertCooldownMinutes] = useState(30);
  const [alertConfigured, setAlertConfigured] = useState(false);
  const [alertRotateSecret, setAlertRotateSecret] = useState(false);
  const [alertMsg, setAlertMsg] = useState('');
  const [alertSecret, setAlertSecret] = useState('');
  const [alertSecretCopied, setAlertSecretCopied] = useState(false);

  useEffect(() => {
    if (!token) return;

    adminSettings.getSmtp(token).then((data) => {
      setSmtpConfigured(data.configured);
      if (data.host) setSmtpHost(data.host);
      if (data.port) setSmtpPort(data.port);
      if (data.user) setSmtpUser(data.user);
      if (data.from) setSmtpFrom(data.from);
      if (data.secure !== undefined) setSmtpSecure(data.secure);
    }).catch(() => {});

    adminSettings.getFooterLinks(token).then(setFooterLinks).catch(() => {});

    adminSettings.getAlertWebhook(token).then((data) => {
      if (!('url' in data)) return;
      setAlertConfigured(true);
      setAlertUrl(data.url);
      setAlertType(data.type);
      setAlertEnabled(data.enabled);
      setAlertThreshold(data.threshold);
      setAlertWindowMinutes(data.windowMinutes);
      setAlertCooldownMinutes(data.cooldownMinutes);
    }).catch(() => {});
  }, [token]);

  const handleSaveSmtp = async () => {
    if (!token) return;
    try {
      await adminSettings.updateSmtp({
        host: smtpHost,
        port: smtpPort,
        user: smtpUser,
        pass: smtpPass,
        from: smtpFrom,
        secure: smtpSecure,
      }, token);
      setSmtpConfigured(true);
      setSmtpPass('');
      setSmtpMsg('SMTP configuration saved');
      setTimeout(() => setSmtpMsg(''), 3000);
    } catch (err: any) {
      setSmtpMsg(`Error: ${err.message}`);
    }
  };

  const handleTestSmtp = async () => {
    if (!token) return;
    setSmtpMsg('Testing connection...');
    try {
      const result = await adminSettings.testSmtp(token);
      setSmtpMsg(result.ok ? result.message : `Error: ${result.message}`);
    } catch (err: any) {
      setSmtpMsg(`Error: ${err.message}`);
    }
  };

  const handleRemoveSmtp = async () => {
    if (!token) return;
    if (!confirm('Remove the workspace SMTP configuration? Emails will be sent by the platform mail service instead.')) return;
    try {
      await adminSettings.deleteSmtp(token);
      setSmtpConfigured(false);
      setSmtpHost('');
      setSmtpPort(587);
      setSmtpUser('');
      setSmtpPass('');
      setSmtpFrom('');
      setSmtpSecure(false);
      setSmtpMsg('SMTP configuration removed — emails now use the platform mail service');
    } catch (err: any) {
      setSmtpMsg(`Error: ${err.message}`);
    }
  };

  const handleSaveAlertWebhook = async () => {
    if (!token) return;
    const data: AlertWebhookInput = {
      url: alertUrl,
      type: alertType,
      enabled: alertEnabled,
      threshold: alertThreshold,
      windowMinutes: alertWindowMinutes,
      cooldownMinutes: alertCooldownMinutes,
      rotateSecret: alertRotateSecret,
    };
    try {
      const result = await adminSettings.updateAlertWebhook(data, token);
      setAlertConfigured(true);
      setAlertRotateSecret(false);
      setAlertMsg('Alert webhook saved');
      setTimeout(() => setAlertMsg(''), 3000);
      if (result.secret) {
        setAlertSecret(result.secret);
        setAlertSecretCopied(false);
      }
    } catch (err: any) {
      setAlertMsg(`Error: ${err.message}`);
    }
  };

  const handleTestAlertWebhook = async () => {
    if (!token) return;
    setAlertMsg('Sending test alert...');
    try {
      const result = await adminSettings.testAlertWebhook(token);
      setAlertMsg(result.success ? 'Test alert delivered' : `Error: ${result.message || 'delivery failed'}`);
    } catch (err: any) {
      setAlertMsg(`Error: ${err.message}`);
    }
  };

  const handleRemoveAlertWebhook = async () => {
    if (!token) return;
    if (!confirm('Remove the connector-failure alert webhook? Alerts will stop firing for this organization.')) return;
    try {
      await adminSettings.deleteAlertWebhook(token);
      setAlertConfigured(false);
      setAlertUrl('');
      setAlertType('json');
      setAlertEnabled(true);
      setAlertThreshold(5);
      setAlertWindowMinutes(10);
      setAlertCooldownMinutes(30);
      setAlertSecret('');
      setAlertMsg('Alert webhook removed');
    } catch (err: any) {
      setAlertMsg(`Error: ${err.message}`);
    }
  };

  const handleCopyAlertSecret = async () => {
    const ok = await copyText(alertSecret);
    if (ok) {
      setAlertSecretCopied(true);
      setTimeout(() => setAlertSecretCopied(false), 2000);
    }
  };

  const handleSaveFooterLinks = async () => {
    if (!token) return;
    try {
      await adminSettings.updateFooterLinks(footerLinks.filter(l => l.label && l.url), token);
      setFooterMsg('Footer links saved');
      setTimeout(() => setFooterMsg(''), 3000);
    } catch (err: any) {
      setFooterMsg(`Error: ${err.message}`);
    }
  };

  if (user?.role !== 'ADMIN') {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--text)] mb-2">Access Denied</h2>
          <p className="text-[var(--text-2)] mb-4">Only administrators can access this page.</p>
          <Link href="/settings" className="text-[var(--brand)] hover:underline">Back to Settings</Link>
        </div>
      </div>
    );
  }

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';

  return (
    <div className="space-y-6">
      {/* SMTP Configuration */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">Email / SMTP Configuration</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          Configure SMTP settings for password reset emails and notifications.
        </p>
        <div className="space-y-4 max-w-lg">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>SMTP Host</label>
              <input
                type="text"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.gmail.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Port</label>
              <input
                type="number"
                value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value))}
                className={inputClass}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Username</label>
              <input
                type="text"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                placeholder="user@example.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input
                type="password"
                value={smtpPass}
                onChange={(e) => setSmtpPass(e.target.value)}
                placeholder={smtpConfigured ? '••••••••  (enter new to update)' : 'SMTP password'}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>From Address (optional)</label>
            <input
              type="text"
              value={smtpFrom}
              onChange={(e) => setSmtpFrom(e.target.value)}
              placeholder="Anything MCP <noreply@example.com>"
              className={inputClass}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="smtpSecure"
              checked={smtpSecure}
              onChange={(e) => setSmtpSecure(e.target.checked)}
              className="accent-[var(--brand)]"
            />
            <label htmlFor="smtpSecure" className="text-sm text-[var(--text-2)]">Use SSL/TLS (port 465)</label>
          </div>
          {smtpMsg && (
            <p className={`text-sm ${smtpMsg.startsWith('Error') ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {smtpMsg}
            </p>
          )}
          <div className="flex gap-2">
            {/* Existing config: password field may stay empty (kept server-side) */}
            <Button onClick={handleSaveSmtp} disabled={!smtpHost || !smtpUser || (!smtpPass && !smtpConfigured)}>
              Save SMTP Config
            </Button>
            {smtpConfigured && (
              <>
                <Button variant="secondary" onClick={handleTestSmtp}>
                  Test Connection
                </Button>
                <Button variant="ghost" onClick={handleRemoveSmtp} className="text-[var(--danger)] hover:text-[var(--danger)]">
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Connector Failure Alerts */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">Connector Failure Alerts</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          Get a webhook or Slack notification when a connector keeps failing, instead of finding out from the logs.
        </p>
        <div className="space-y-4 max-w-lg">
          <div>
            <label className={labelClass}>Webhook URL</label>
            <input
              type="text"
              value={alertUrl}
              onChange={(e) => setAlertUrl(e.target.value)}
              placeholder="https://example.com/hooks/anythingmcp"
              className={inputClass}
            />
            {isCloud && (
              <p className="text-[11.5px] text-[var(--text-3)] mt-1">On AnythingMCP Cloud the URL must use https.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Payload type</label>
              <AppSelect
                value={alertType}
                onValueChange={(v) => setAlertType(v as 'json' | 'slack')}
                options={ALERT_WEBHOOK_TYPE_OPTIONS}
                className={inputClass}
                aria-label="Payload type"
              />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                id="alertEnabled"
                checked={alertEnabled}
                onChange={(e) => setAlertEnabled(e.target.checked)}
                className="accent-[var(--brand)]"
              />
              <label htmlFor="alertEnabled" className="text-sm text-[var(--text-2)]">Enabled</label>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Failure threshold</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(Number(e.target.value))}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Window (minutes)</label>
              <input
                type="number"
                min={1}
                max={1440}
                value={alertWindowMinutes}
                onChange={(e) => setAlertWindowMinutes(Number(e.target.value))}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Cooldown (minutes)</label>
              <input
                type="number"
                min={1}
                max={10080}
                value={alertCooldownMinutes}
                onChange={(e) => setAlertCooldownMinutes(Number(e.target.value))}
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-[11.5px] text-[var(--text-3)]">
            Alerts after {alertThreshold} failures of the same connector within {alertWindowMinutes} minutes, then waits {alertCooldownMinutes} minutes before alerting again.
          </p>
          {alertConfigured && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="alertRotateSecret"
                checked={alertRotateSecret}
                onChange={(e) => setAlertRotateSecret(e.target.checked)}
                className="accent-[var(--brand)]"
              />
              <label htmlFor="alertRotateSecret" className="text-sm text-[var(--text-2)]">
                Rotate signing secret on save
              </label>
            </div>
          )}
          {alertSecret && (
            <div className="rounded-[9px] border border-[var(--brand)] bg-[var(--brand-tint)] p-3 space-y-2">
              <p className="text-[12.5px] font-medium text-[var(--text)]">
                Signing secret — shown once, copy it now:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto text-[12px] text-[var(--text)]">{alertSecret}</code>
                <Button size="sm" variant="secondary" onClick={handleCopyAlertSecret}>
                  {alertSecretCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-[11.5px] text-[var(--text-3)]">
                Use this to verify the <code>X-AnythingMCP-Signature</code> header. It will not be shown again.
              </p>
            </div>
          )}
          {alertMsg && (
            <p className={`text-sm ${alertMsg.startsWith('Error') ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {alertMsg}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={handleSaveAlertWebhook} disabled={!alertUrl}>
              Save Alert Webhook
            </Button>
            {alertConfigured && (
              <>
                <Button variant="secondary" onClick={handleTestAlertWebhook}>
                  Send Test Alert
                </Button>
                <Button variant="ghost" onClick={handleRemoveAlertWebhook} className="text-[var(--danger)] hover:text-[var(--danger)]">
                  Remove
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Footer Links */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">Footer Links</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          Add links for Impressum, Privacy Policy, Terms of Service, etc. These appear in the footer of every page.
        </p>
        <div className="space-y-3 max-w-lg">
          {footerLinks.map((link, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="text"
                value={link.label}
                onChange={(e) => {
                  const updated = [...footerLinks];
                  updated[i] = { ...link, label: e.target.value };
                  setFooterLinks(updated);
                }}
                placeholder="Label (e.g., Privacy Policy)"
                className="w-1/3 h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
              />
              <input
                type="text"
                value={link.url}
                onChange={(e) => {
                  const updated = [...footerLinks];
                  updated[i] = { ...link, url: e.target.value };
                  setFooterLinks(updated);
                }}
                placeholder="https://example.com/privacy"
                className="flex-1 h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]"
              />
              <Button variant="ghost" size="sm" onClick={() => setFooterLinks(footerLinks.filter((_, j) => j !== i))} className="text-[var(--danger)] hover:text-[var(--danger)]">
                Remove
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setFooterLinks([...footerLinks, { label: '', url: '' }])}>
              + Add Link
            </Button>
            <Button size="sm" onClick={handleSaveFooterLinks}>
              Save Footer Links
            </Button>
          </div>
          {footerMsg && (
            <p className={`text-sm ${footerMsg.startsWith('Error') ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {footerMsg}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
