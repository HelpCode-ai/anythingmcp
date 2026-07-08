'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { adminSettings } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function AdminSettingsPage() {
  const { token, user } = useAuth();

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

  // SSRF allowlist
  const [ssrfHosts, setSsrfHosts] = useState<string[]>([]);
  const [ssrfEnvHosts, setSsrfEnvHosts] = useState<string[]>([]);
  const [ssrfDraft, setSsrfDraft] = useState('');
  const [ssrfMsg, setSsrfMsg] = useState('');

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

    adminSettings.getSsrfAllowedHosts(token).then((data) => {
      setSsrfHosts(data.hosts);
      setSsrfEnvHosts(data.envHosts);
      setSsrfDraft(data.hosts.join('\n'));
    }).catch(() => {});
  }, [token]);

  const handleSaveSsrfHosts = async () => {
    if (!token) return;
    const hosts = ssrfDraft
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const result = await adminSettings.setSsrfAllowedHosts(hosts, token);
      setSsrfHosts(result.hosts);
      setSsrfDraft(result.hosts.join('\n'));
      setSsrfMsg('SSRF allowlist saved');
      setTimeout(() => setSsrfMsg(''), 3000);
    } catch (err: any) {
      setSsrfMsg(`Error: ${err.message}`);
    }
  };

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
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2 text-[var(--text)]">Access Denied</h2>
          <p className="text-[var(--text-3)]">Only administrators can access this page.</p>
        </div>
      </div>
    );
  }

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]';

  return (
    <AppShell
      title="Admin Settings"
    >
      <div className="space-y-6">
        {/* SMTP Configuration */}
        <Card className="p-6">
          <h3 className="text-[15px] font-semibold mb-2 text-[var(--text)]">Email / SMTP Configuration</h3>
          <p className="text-sm text-[var(--text-3)] mb-4">
            Configure SMTP settings for password reset emails and notifications.
          </p>
          <div className="space-y-4 max-w-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">SMTP Host</label>
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.gmail.com"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">Port</label>
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
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">Username</label>
                <input
                  type="text"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  placeholder="user@example.com"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">Password</label>
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
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">From Address (optional)</label>
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
              />
              <label htmlFor="smtpSecure" className="text-sm text-[var(--text-2)]">Use SSL/TLS (port 465)</label>
            </div>
            {smtpMsg && (
              <p className="text-sm" style={{ color: smtpMsg.startsWith('Error') ? 'var(--danger)' : 'var(--ok)' }}>
                {smtpMsg}
              </p>
            )}
            <div className="flex gap-2">
              {/* Existing config: password field may stay empty (kept server-side) */}
              <Button
                onClick={handleSaveSmtp}
                disabled={!smtpHost || !smtpUser || (!smtpPass && !smtpConfigured)}
              >
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

        {/* Footer Links */}
        <Card className="p-6">
          <h3 className="text-[15px] font-semibold mb-2 text-[var(--text)]">Footer Links</h3>
          <p className="text-sm text-[var(--text-3)] mb-4">
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
                  className="w-1/3 h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]"
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
                  className="flex-1 h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]"
                />
                <button
                  onClick={() => setFooterLinks(footerLinks.filter((_, j) => j !== i))}
                  className="text-[var(--danger)] px-2 py-1 text-sm hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setFooterLinks([...footerLinks, { label: '', url: '' }])}
              >
                + Add Link
              </Button>
              <Button size="sm" onClick={handleSaveFooterLinks}>
                Save Footer Links
              </Button>
            </div>
            {footerMsg && (
              <p className="text-sm" style={{ color: footerMsg.startsWith('Error') ? 'var(--danger)' : 'var(--ok)' }}>
                {footerMsg}
              </p>
            )}
          </div>
        </Card>

        {/* SSRF Allowlist */}
        <Card id="ssrf" className="p-6">
          <h3 className="text-[15px] font-semibold mb-2 text-[var(--text)]">SSRF allowlist</h3>
          <p className="text-sm text-[var(--text-3)] mb-2">
            Hostnames (or <code>*.suffix</code> wildcards / plain IPs) that
            the SSRF guard will let through when they resolve to a private
            network address. Needed when connectors call services on the
            internal network — e.g. a Docker-compose service like{' '}
            <code>koch-filesystem-bridge</code>.
          </p>
          <p className="text-xs mb-4 font-medium" style={{ color: 'var(--danger)' }}>
            ⚠ Use with caution. Anything added here can be reached by every
            connector in every organization on this deployment. Do not add
            hosts you don&apos;t fully trust.
          </p>

          {ssrfEnvHosts.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold mb-1 text-[var(--text-2)]">
                From <code>SSRF_ALLOWED_HOSTS</code> env var (read-only):
              </p>
              <div className="text-xs font-mono bg-[var(--surface-2)] text-[var(--text)] rounded-[9px] p-2">
                {ssrfEnvHosts.join(', ')}
              </div>
            </div>
          )}

          <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">
            Admin-editable list (one host per line)
          </label>
          <textarea
            value={ssrfDraft}
            onChange={(e) => setSsrfDraft(e.target.value)}
            placeholder="koch-filesystem-bridge&#10;*.internal.example.com&#10;172.23.0.0"
            rows={5}
            className="w-full max-w-lg rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)] font-mono"
          />
          <div className="flex gap-2 mt-3">
            <Button size="sm" onClick={handleSaveSsrfHosts}>
              Save allowlist
            </Button>
          </div>
          {ssrfMsg && (
            <p
              className="text-sm mt-2"
              style={{ color: ssrfMsg.startsWith('Error') ? 'var(--danger)' : 'var(--ok)' }}
            >
              {ssrfMsg}
            </p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
