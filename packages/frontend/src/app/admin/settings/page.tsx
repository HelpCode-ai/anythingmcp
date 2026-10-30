'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { adminSettings, FOOTER_LINKS_CHANGED } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function AdminSettingsPage() {
  const { token, user, deploymentMode, deploymentModeLoaded } = useAuth();
  const t = useTranslations('settingsAdmin');
  const ta = useTranslations('adminPages');
  // Instance-wide setting: the cloud operator manages it on the server.
  const showSsrf = deploymentModeLoaded && deploymentMode !== 'cloud';

  // SMTP
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [smtpMsg, setSmtpMsg] = useState('');
  const [smtpMsgIsError, setSmtpMsgIsError] = useState(false);

  // Footer links
  const [footerLinks, setFooterLinks] = useState<Array<{ label: string; url: string }>>([]);
  const [footerMsg, setFooterMsg] = useState('');
  const [footerMsgIsError, setFooterMsgIsError] = useState(false);

  // SSRF allowlist
  const [ssrfHosts, setSsrfHosts] = useState<string[]>([]);
  const [ssrfEnvHosts, setSsrfEnvHosts] = useState<string[]>([]);
  const [ssrfDraft, setSsrfDraft] = useState('');
  const [ssrfMsg, setSsrfMsg] = useState('');
  const [ssrfMsgIsError, setSsrfMsgIsError] = useState(false);

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

    if (showSsrf) {
      adminSettings.getSsrfAllowedHosts(token).then((data) => {
        setSsrfHosts(data.hosts);
        setSsrfEnvHosts(data.envHosts);
        setSsrfDraft(data.hosts.join('\n'));
      }).catch(() => {});
    }
  }, [token, showSsrf]);

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
      setSsrfMsgIsError(false);
      setSsrfMsg(ta('ssrf.saved'));
      setTimeout(() => setSsrfMsg(''), 3000);
    } catch (err: any) {
      setSsrfMsgIsError(true);
      setSsrfMsg(t('error', { message: err.message }));
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
      setSmtpMsgIsError(false);
      setSmtpMsg(t('smtp.saved'));
      setTimeout(() => setSmtpMsg(''), 3000);
    } catch (err: any) {
      setSmtpMsgIsError(true);
      setSmtpMsg(t('error', { message: err.message }));
    }
  };

  const handleTestSmtp = async () => {
    if (!token) return;
    setSmtpMsgIsError(false);
    setSmtpMsg(t('smtp.testing'));
    try {
      const result = await adminSettings.testSmtp(token);
      setSmtpMsgIsError(!result.ok);
      setSmtpMsg(result.ok ? result.message : t('error', { message: result.message }));
    } catch (err: any) {
      setSmtpMsgIsError(true);
      setSmtpMsg(t('error', { message: err.message }));
    }
  };

  const handleRemoveSmtp = async () => {
    if (!token) return;
    if (!confirm(t('smtp.confirmRemove'))) return;
    try {
      await adminSettings.deleteSmtp(token);
      setSmtpConfigured(false);
      setSmtpHost('');
      setSmtpPort(587);
      setSmtpUser('');
      setSmtpPass('');
      setSmtpFrom('');
      setSmtpSecure(false);
      setSmtpMsgIsError(false);
      setSmtpMsg(t('smtp.removed'));
    } catch (err: any) {
      setSmtpMsgIsError(true);
      setSmtpMsg(t('error', { message: err.message }));
    }
  };

  const handleSaveFooterLinks = async () => {
    if (!token) return;
    try {
      await adminSettings.updateFooterLinks(footerLinks.filter(l => l.label && l.url), token);
      window.dispatchEvent(new Event(FOOTER_LINKS_CHANGED));
      setFooterMsgIsError(false);
      setFooterMsg(t('footer.saved'));
      setTimeout(() => setFooterMsg(''), 3000);
    } catch (err: any) {
      setFooterMsgIsError(true);
      setFooterMsg(t('error', { message: err.message }));
    }
  };

  if (user?.role !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2 text-[var(--text)]">{t('accessDenied.title')}</h2>
          <p className="text-[var(--text-3)]">{t('accessDenied.body')}</p>
        </div>
      </div>
    );
  }

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)]';

  return (
    <AppShell
      title={ta('settings.title')}
    >
      <div className="space-y-6">
        {/* SMTP Configuration */}
        <Card className="p-6">
          <h3 className="text-[15px] font-semibold mb-2 text-[var(--text)]">{t('smtp.title')}</h3>
          <p className="text-sm text-[var(--text-3)] mb-4">
            {t('smtp.intro')}
          </p>
          <div className="space-y-4 max-w-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('smtp.host')}</label>
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  placeholder="smtp.gmail.com"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('smtp.port')}</label>
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
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('smtp.user')}</label>
                <input
                  type="text"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  placeholder="user@example.com"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('smtp.password')}</label>
                <input
                  type="password"
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  placeholder={smtpConfigured ? t('smtp.passwordKeep') : t('smtp.passwordPlaceholder')}
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">{t('smtp.from')}</label>
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
              <label htmlFor="smtpSecure" className="text-sm text-[var(--text-2)]">{t('smtp.secure')}</label>
            </div>
            {smtpMsg && (
              <p className="text-sm" style={{ color: smtpMsgIsError ? 'var(--danger)' : 'var(--ok)' }}>
                {smtpMsg}
              </p>
            )}
            <div className="flex gap-2">
              {/* Existing config: password field may stay empty (kept server-side) */}
              <Button
                onClick={handleSaveSmtp}
                disabled={!smtpHost || !smtpUser || (!smtpPass && !smtpConfigured)}
              >
                {t('smtp.save')}
              </Button>
              {smtpConfigured && (
                <>
                  <Button variant="secondary" onClick={handleTestSmtp}>
                    {t('smtp.test')}
                  </Button>
                  <Button variant="ghost" onClick={handleRemoveSmtp} className="text-[var(--danger)] hover:text-[var(--danger)]">
                    {t('remove')}
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>

        {/* Footer Links */}
        <Card className="p-6">
          <h3 className="text-[15px] font-semibold mb-2 text-[var(--text)]">{t('footer.title')}</h3>
          <p className="text-sm text-[var(--text-3)] mb-4">
            {t('footer.intro')}
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
                  placeholder={t('footer.labelPlaceholder')}
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
                  {t('remove')}
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setFooterLinks([...footerLinks, { label: '', url: '' }])}
              >
                {t('footer.add')}
              </Button>
              <Button size="sm" onClick={handleSaveFooterLinks}>
                {t('footer.save')}
              </Button>
            </div>
            {footerMsg && (
              <p className="text-sm" style={{ color: footerMsgIsError ? 'var(--danger)' : 'var(--ok)' }}>
                {footerMsg}
              </p>
            )}
          </div>
        </Card>

        {/* SSRF Allowlist */}
        {showSsrf && (
        <Card id="ssrf" className="p-6">
          <h3 className="text-[15px] font-semibold mb-2 text-[var(--text)]">{ta('ssrf.title')}</h3>
          <p className="text-sm text-[var(--text-3)] mb-2">
            {ta.rich('ssrf.intro', { code: (chunks) => <code>{chunks}</code> })}
          </p>
          <p className="text-xs mb-4 font-medium" style={{ color: 'var(--danger)' }}>
            {ta('ssrf.warning')}
          </p>

          {ssrfEnvHosts.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold mb-1 text-[var(--text-2)]">
                {ta.rich('ssrf.envHosts', { code: (chunks) => <code>{chunks}</code> })}
              </p>
              <div className="text-xs font-mono bg-[var(--surface-2)] text-[var(--text)] rounded-[9px] p-2">
                {ssrfEnvHosts.join(', ')}
              </div>
            </div>
          )}

          <label className="block text-sm font-medium mb-1 text-[var(--text-2)]">
            {ta('ssrf.list')}
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
              {ta('ssrf.save')}
            </Button>
          </div>
          {ssrfMsg && (
            <p
              className="text-sm mt-2"
              style={{ color: ssrfMsgIsError ? 'var(--danger)' : 'var(--ok)' }}
            >
              {ssrfMsg}
            </p>
          )}
        </Card>
        )}
      </div>
    </AppShell>
  );
}
