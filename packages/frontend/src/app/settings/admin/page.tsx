'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { adminSettings } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function SettingsAdminPage() {
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
