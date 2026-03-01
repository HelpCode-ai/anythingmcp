'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { adminSettings } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';

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
      setSmtpMsg(result.ok ? 'Connection successful!' : `Error: ${result.message}`);
      setTimeout(() => setSmtpMsg(''), 5000);
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
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2">Access Denied</h2>
          <p className="text-[var(--muted-foreground)]">Only administrators can access this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="Admin Settings"
      />

      <main className="max-w-7xl mx-auto px-6 py-8 flex-1 w-full">
        <div className="space-y-6">
          {/* SMTP Configuration */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-2">Email / SMTP Configuration</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
              Configure SMTP settings for password reset emails and notifications.
            </p>
            <div className="space-y-4 max-w-lg">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">SMTP Host</label>
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.gmail.com"
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Port</label>
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(Number(e.target.value))}
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Username</label>
                  <input
                    type="text"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder="user@example.com"
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Password</label>
                  <input
                    type="password"
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    placeholder={smtpConfigured ? '••••••••  (enter new to update)' : 'SMTP password'}
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">From Address (optional)</label>
                <input
                  type="text"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  placeholder="AnythingToMCP <noreply@example.com>"
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="smtpSecure"
                  checked={smtpSecure}
                  onChange={(e) => setSmtpSecure(e.target.checked)}
                />
                <label htmlFor="smtpSecure" className="text-sm">Use SSL/TLS (port 465)</label>
              </div>
              {smtpMsg && (
                <p className={`text-sm ${smtpMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                  {smtpMsg}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleSaveSmtp}
                  disabled={!smtpHost || !smtpUser || !smtpPass}
                  className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
                >
                  Save SMTP Config
                </button>
                {smtpConfigured && (
                  <button
                    onClick={handleTestSmtp}
                    className="border border-[var(--border)] px-4 py-2 rounded-md text-sm hover:bg-[var(--accent)]"
                  >
                    Test Connection
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Footer Links */}
          <div className="border border-[var(--border)] rounded-lg p-6">
            <h3 className="text-lg font-medium mb-2">Footer Links</h3>
            <p className="text-sm text-[var(--muted-foreground)] mb-4">
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
                    className="w-1/3 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
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
                    className="flex-1 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  />
                  <button
                    onClick={() => setFooterLinks(footerLinks.filter((_, j) => j !== i))}
                    className="text-[var(--destructive)] px-2 py-1 text-sm hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex gap-2">
                <button
                  onClick={() => setFooterLinks([...footerLinks, { label: '', url: '' }])}
                  className="border border-[var(--border)] px-3 py-1.5 rounded text-sm hover:bg-[var(--accent)]"
                >
                  + Add Link
                </button>
                <button
                  onClick={handleSaveFooterLinks}
                  className="bg-[var(--brand)] text-white px-4 py-1.5 rounded text-sm font-medium hover:brightness-90"
                >
                  Save Footer Links
                </button>
              </div>
              {footerMsg && (
                <p className={`text-sm ${footerMsg.startsWith('Error') ? 'text-[var(--destructive)]' : 'text-[var(--success)]'}`}>
                  {footerMsg}
                </p>
              )}
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
