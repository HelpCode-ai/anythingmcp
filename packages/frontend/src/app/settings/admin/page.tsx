'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { adminSettings, versionApi, FOOTER_LINKS_CHANGED, type AlertWebhookInput } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AppSelect } from '@/components/ui/select';
import { copyText } from '@/lib/clipboard';

const ALERT_WEBHOOK_TYPES = ['json', 'slack'] as const;

export default function SettingsAdminPage() {
  const t = useTranslations('settingsAdmin');
  const { token, user, deploymentMode } = useAuth();
  const isCloud = deploymentMode === 'cloud';
  const alertTypeOptions = ALERT_WEBHOOK_TYPES.map((value) => ({ value, label: t(`alerts.types.${value}`) }));

  // SMTP
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [smtpMsg, setSmtpMsg] = useState('');
  // Colour comes from this flag, not from the message text, which is translated.
  const [smtpMsgIsError, setSmtpMsgIsError] = useState(false);
  const smtpNote = (text: string, isError = false) => {
    setSmtpMsg(text);
    setSmtpMsgIsError(isError);
  };

  // Footer links
  const [footerLinks, setFooterLinks] = useState<Array<{ label: string; url: string }>>([]);
  const [versionInfo, setVersionInfo] = useState<{ version: string; commit: string; buildDate: string | null; deploymentMode: string } | null>(null);
  const [versionMsg, setVersionMsg] = useState('');
  const [versionMsgIsError, setVersionMsgIsError] = useState(false);
  const [footerMsg, setFooterMsg] = useState('');
  const [footerMsgIsError, setFooterMsgIsError] = useState(false);
  const footerNote = (text: string, isError = false) => {
    setFooterMsg(text);
    setFooterMsgIsError(isError);
  };

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
  const [alertMsgIsError, setAlertMsgIsError] = useState(false);
  const alertNote = (text: string, isError = false) => {
    setAlertMsg(text);
    setAlertMsgIsError(isError);
  };
  const [alertSecret, setAlertSecret] = useState('');
  const [alertSecretCopied, setAlertSecretCopied] = useState(false);
  // One request at a time: a double-clicked save with "rotate" would mint two
  // secrets and could show the one that lost the race.
  const [alertBusy, setAlertBusy] = useState(false);
  // The URL the backend has, so a test is never sent to an unsaved edit.
  const [savedAlertUrl, setSavedAlertUrl] = useState('');

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
    versionApi.get(token).then(setVersionInfo).catch(() => {});

    adminSettings.getAlertWebhook(token).then((data) => {
      if (!('url' in data)) return;
      setAlertConfigured(true);
      setAlertUrl(data.url);
      setSavedAlertUrl(data.url);
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
      smtpNote(t('smtp.saved'));
      setTimeout(() => setSmtpMsg(''), 3000);
    } catch (err: any) {
      smtpNote(t('error', { message: err.message }), true);
    }
  };

  const handleTestSmtp = async () => {
    if (!token) return;
    smtpNote(t('smtp.testing'));
    try {
      const result = await adminSettings.testSmtp(token);
      smtpNote(result.ok ? result.message : t('error', { message: result.message }), !result.ok);
    } catch (err: any) {
      smtpNote(t('error', { message: err.message }), true);
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
      smtpNote(t('smtp.removed'));
    } catch (err: any) {
      smtpNote(t('error', { message: err.message }), true);
    }
  };

  const handleSaveAlertWebhook = async () => {
    if (!token) return;
    const url = alertUrl.trim();
    const data: AlertWebhookInput = {
      url,
      type: alertType,
      enabled: alertEnabled,
      threshold: alertThreshold,
      windowMinutes: alertWindowMinutes,
      cooldownMinutes: alertCooldownMinutes,
      rotateSecret: alertRotateSecret,
    };
    setAlertBusy(true);
    try {
      const result = await adminSettings.updateAlertWebhook(data, token);
      setAlertConfigured(true);
      setAlertUrl(url);
      setSavedAlertUrl(url);
      setAlertRotateSecret(false);
      alertNote(t('alerts.saved'));
      setTimeout(() => setAlertMsg(''), 3000);
      if (result.secret) {
        setAlertSecret(result.secret);
        setAlertSecretCopied(false);
      }
    } catch (err: any) {
      alertNote(t('error', { message: err.message }), true);
    } finally {
      setAlertBusy(false);
    }
  };

  const handleTestAlertWebhook = async () => {
    if (!token) return;
    setAlertBusy(true);
    alertNote(t('alerts.sendingTest'));
    try {
      const result = await adminSettings.testAlertWebhook(token);
      if (result.success) alertNote(t('alerts.testDelivered'));
      else alertNote(t('error', { message: result.message || t('alerts.deliveryFailed') }), true);
    } catch (err: any) {
      alertNote(t('error', { message: err.message }), true);
    } finally {
      setAlertBusy(false);
    }
  };

  const handleRemoveAlertWebhook = async () => {
    if (!token) return;
    if (!confirm(t('alerts.confirmRemove'))) return;
    setAlertBusy(true);
    try {
      await adminSettings.deleteAlertWebhook(token);
      setAlertConfigured(false);
      setAlertUrl('');
      setSavedAlertUrl('');
      setAlertType('json');
      setAlertEnabled(true);
      setAlertThreshold(5);
      setAlertWindowMinutes(10);
      setAlertCooldownMinutes(30);
      setAlertSecret('');
      alertNote(t('alerts.removed'));
    } catch (err: any) {
      alertNote(t('error', { message: err.message }), true);
    } finally {
      setAlertBusy(false);
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
      window.dispatchEvent(new Event(FOOTER_LINKS_CHANGED));
      footerNote(t('footer.saved'));
      setTimeout(() => setFooterMsg(''), 3000);
    } catch (err: any) {
      footerNote(t('error', { message: err.message }), true);
    }
  };

  if (user?.role !== 'ADMIN') {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <h2 className="text-xl font-bold text-[var(--text)] mb-2">{t('accessDenied.title')}</h2>
          <p className="text-[var(--text-2)] mb-4">{t('accessDenied.body')}</p>
          <Link href="/settings" className="text-[var(--brand)] hover:underline">{t('accessDenied.back')}</Link>
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
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('smtp.title')}</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          {t('smtp.intro')}
        </p>
        <div className="space-y-4 max-w-lg">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>{t('smtp.host')}</label>
              <input
                type="text"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.gmail.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('smtp.port')}</label>
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
              <label className={labelClass}>{t('smtp.user')}</label>
              <input
                type="text"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                placeholder="user@example.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('smtp.password')}</label>
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
            <label className={labelClass}>{t('smtp.from')}</label>
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
            <label htmlFor="smtpSecure" className="text-sm text-[var(--text-2)]">{t('smtp.secure')}</label>
          </div>
          {smtpMsg && (
            <p className={`text-sm ${smtpMsgIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {smtpMsg}
            </p>
          )}
          <div className="flex gap-2">
            {/* Existing config: password field may stay empty (kept server-side) */}
            <Button onClick={handleSaveSmtp} disabled={!smtpHost || !smtpUser || (!smtpPass && !smtpConfigured)}>
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

      {/* Connector Failure Alerts */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('alerts.title')}</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          {t('alerts.intro')}
        </p>
        <div className="space-y-4 max-w-lg">
          <div>
            <label htmlFor="alertUrl" className={labelClass}>{t('alerts.url')}</label>
            <input
              id="alertUrl"
              type="text"
              value={alertUrl}
              onChange={(e) => setAlertUrl(e.target.value)}
              placeholder="https://example.com/hooks/anythingmcp"
              className={inputClass}
            />
            {isCloud && (
              <p className="text-[11.5px] text-[var(--text-3)] mt-1">{t('alerts.cloudHttps')}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>{t('alerts.payloadType')}</label>
              <AppSelect
                value={alertType}
                onValueChange={(v) => setAlertType(v as 'json' | 'slack')}
                options={alertTypeOptions}
                className={inputClass}
                aria-label={t('alerts.payloadType')}
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
              <label htmlFor="alertEnabled" className="text-sm text-[var(--text-2)]">{t('alerts.enabled')}</label>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label htmlFor="alertThreshold" className={labelClass}>{t('alerts.threshold')}</label>
              <input
                id="alertThreshold"
                type="number"
                step={1}
                min={1}
                max={1000}
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(Number(e.target.value))}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="alertWindowMinutes" className={labelClass}>{t('alerts.window')}</label>
              <input
                id="alertWindowMinutes"
                type="number"
                step={1}
                min={1}
                max={1440}
                value={alertWindowMinutes}
                onChange={(e) => setAlertWindowMinutes(Number(e.target.value))}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="alertCooldownMinutes" className={labelClass}>{t('alerts.cooldown')}</label>
              <input
                id="alertCooldownMinutes"
                type="number"
                step={1}
                min={1}
                max={10080}
                value={alertCooldownMinutes}
                onChange={(e) => setAlertCooldownMinutes(Number(e.target.value))}
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-[11.5px] text-[var(--text-3)]">
            {t('alerts.summary', { threshold: alertThreshold, window: alertWindowMinutes, cooldown: alertCooldownMinutes })}
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
                {t('alerts.rotate')}
              </label>
            </div>
          )}
          {alertSecret && (
            <div className="rounded-[9px] border border-[var(--brand)] bg-[var(--brand-tint)] p-3 space-y-2">
              <p className="text-[12.5px] font-medium text-[var(--text)]">
                {t('alerts.secretOnce')}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto text-[12px] text-[var(--text)]">{alertSecret}</code>
                <Button size="sm" variant="secondary" onClick={handleCopyAlertSecret}>
                  {alertSecretCopied ? t('copied') : t('copy')}
                </Button>
              </div>
              <p className="text-[11.5px] text-[var(--text-3)]">
                {t.rich('alerts.secretHelp', { code: (chunks) => <code>{chunks}</code> })}
              </p>
              <Button size="sm" variant="secondary" onClick={() => setAlertSecret('')}>
                {t('alerts.savedIt')}
              </Button>
            </div>
          )}
          {alertMsg && (
            <p role="status" className={`text-sm ${alertMsgIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {alertMsg}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={handleSaveAlertWebhook} disabled={alertBusy || !alertUrl.trim()}>
              {t('alerts.save')}
            </Button>
            {alertConfigured && (
              <>
                <Button
                  variant="secondary"
                  onClick={handleTestAlertWebhook}
                  disabled={alertBusy || alertUrl.trim() !== savedAlertUrl}
                  title={alertUrl.trim() !== savedAlertUrl ? t('alerts.saveUrlFirst') : undefined}
                >
                  {t('alerts.sendTest')}
                </Button>
                <Button variant="ghost" onClick={handleRemoveAlertWebhook} disabled={alertBusy} className="text-[var(--danger)] hover:text-[var(--danger)]">
                  {t('remove')}
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Footer Links */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('footer.title')}</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
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
                {t('remove')}
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setFooterLinks([...footerLinks, { label: '', url: '' }])}>
              {t('footer.add')}
            </Button>
            <Button size="sm" onClick={handleSaveFooterLinks}>
              {t('footer.save')}
            </Button>
          </div>
          {footerMsg && (
            <p className={`text-sm ${footerMsgIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {footerMsg}
            </p>
          )}
        </div>
      </Card>

      {/* About this instance */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('about.title')}</h3>
        {!versionInfo && (
          <p className="text-sm text-[var(--text-3)]">{t('about.unavailable')}</p>
        )}
        {versionInfo && (
          <div className="space-y-2">
            <p className="text-sm text-[var(--text-2)]">
              {t('about.version')} <span className="font-mono">{versionInfo.version}</span> · {t('about.commit')}{' '}
              <span className="font-mono">
                {/^[0-9a-f]{40}$/.test(versionInfo.commit) ? versionInfo.commit.slice(0, 7) : versionInfo.commit}
              </span>
              {versionInfo.buildDate && <> · {t('about.built', { date: versionInfo.buildDate.slice(0, 10) })}</>}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                const text = `AnythingMCP v${versionInfo.version} (commit ${versionInfo.commit}, built ${versionInfo.buildDate ?? 'unknown'}, mode ${versionInfo.deploymentMode})`;
                const ok = await copyText(text);
                // The copied text stays English: it is pasted into bug reports.
                setVersionMsg(ok ? t('about.copied') : t('about.copyFailed'));
                setVersionMsgIsError(!ok);
              }}
            >
              {t('about.copy')}
            </Button>
            {versionMsg && (
              <p className={`text-sm ${versionMsgIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
                {versionMsg}
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
