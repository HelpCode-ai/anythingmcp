'use client';

import { useTranslations } from 'next-intl';
import { AppSelect } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * The settings form of an EMAIL connector (IMAP for reading, SMTP for
 * sending), shared by the new-connector page and the connector page.
 *
 * Non-secret settings go to `config.email`; the login goes to `authConfig`
 * (BASIC_AUTH). On the connector page the passwords are never shown: an empty
 * password field keeps the stored one (the server merges, see
 * ConnectorsController.mergeEmailAuthConfig).
 */

export type MailSecurity = 'tls' | 'starttls' | 'none';

export interface EmailFormState {
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurity;
  username: string;
  password: string;
  separateSmtpLogin: boolean;
  smtpUsername: string;
  smtpPassword: string;
  fromAddress: string;
  fromName: string;
  sentFolder: string;
  draftsFolder: string;
  saveSent: 'auto' | 'always' | 'never';
  allowSelfSigned: boolean;
}

export const EMPTY_EMAIL_FORM: EmailFormState = {
  imapHost: '',
  imapPort: '993',
  imapSecurity: 'tls',
  smtpHost: '',
  smtpPort: '465',
  smtpSecurity: 'tls',
  username: '',
  password: '',
  separateSmtpLogin: false,
  smtpUsername: '',
  smtpPassword: '',
  fromAddress: '',
  fromName: '',
  sentFolder: '',
  draftsFolder: '',
  saveSent: 'auto',
  allowSelfSigned: false,
};

/** Common providers: picking one fills in the servers and ports. */
const PROVIDERS: Array<{ id: string; label: string; imap: string; imapPort: string; smtp: string; smtpPort: string }> = [
  { id: 'ionos', label: 'IONOS', imap: 'imap.ionos.de', imapPort: '993', smtp: 'smtp.ionos.de', smtpPort: '465' },
  { id: 'strato', label: 'Strato', imap: 'imap.strato.de', imapPort: '993', smtp: 'smtp.strato.de', smtpPort: '465' },
  { id: 'gmx', label: 'GMX', imap: 'imap.gmx.net', imapPort: '993', smtp: 'mail.gmx.net', smtpPort: '587' },
  { id: 'webde', label: 'web.de', imap: 'imap.web.de', imapPort: '993', smtp: 'smtp.web.de', smtpPort: '587' },
  { id: 'tonline', label: 'T-Online', imap: 'secureimap.t-online.de', imapPort: '993', smtp: 'securesmtp.t-online.de', smtpPort: '465' },
  { id: 'gmail', label: 'Gmail / Google Workspace', imap: 'imap.gmail.com', imapPort: '993', smtp: 'smtp.gmail.com', smtpPort: '465' },
  { id: 'yahoo', label: 'Yahoo Mail', imap: 'imap.mail.yahoo.com', imapPort: '993', smtp: 'smtp.mail.yahoo.com', smtpPort: '465' },
  { id: 'icloud', label: 'iCloud Mail', imap: 'imap.mail.me.com', imapPort: '993', smtp: 'smtp.mail.me.com', smtpPort: '587' },
  { id: 'fastmail', label: 'Fastmail', imap: 'imap.fastmail.com', imapPort: '993', smtp: 'smtp.fastmail.com', smtpPort: '465' },
  { id: 'hetzner', label: 'Hetzner', imap: 'mail.your-server.de', imapPort: '993', smtp: 'mail.your-server.de', smtpPort: '587' },
  { id: 'aruba', label: 'Aruba', imap: 'imaps.aruba.it', imapPort: '993', smtp: 'smtps.aruba.it', smtpPort: '465' },
];

function securityForPort(kind: 'imap' | 'smtp', port: string): MailSecurity | null {
  if (kind === 'imap') return port === '993' ? 'tls' : port === '143' ? 'starttls' : null;
  return port === '465' ? 'tls' : port === '587' || port === '25' || port === '2525' ? 'starttls' : null;
}

/** The address the connector lists show (the engine reads config.email). */
export function emailBaseUrl(form: EmailFormState): string {
  const host = form.imapHost.trim();
  const port = form.imapPort.trim() || (form.imapSecurity === 'tls' ? '993' : '143');
  return `${form.imapSecurity === 'tls' ? 'imaps' : 'imap'}://${host}:${port}`;
}

export function emailFormToConfig(form: EmailFormState, existing?: Record<string, unknown>): Record<string, unknown> {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    // Keys this form does not edit (a catalog install's toolPrefix) are kept.
    ...(existing ?? {}),
    imapHost: form.imapHost.trim(),
    imapPort: form.imapPort.trim(),
    imapSecurity: form.imapSecurity,
    smtpHost: opt(form.smtpHost),
    smtpPort: opt(form.smtpPort),
    smtpSecurity: form.smtpHost.trim() ? form.smtpSecurity : undefined,
    fromAddress: opt(form.fromAddress),
    fromName: opt(form.fromName),
    sentFolder: opt(form.sentFolder),
    draftsFolder: opt(form.draftsFolder),
    saveSent: form.saveSent,
    allowSelfSigned: form.allowSelfSigned || undefined,
  };
}

/**
 * The login. On the connector page an empty username or password means
 * "keep the stored one", and a separate SMTP login is only sent when its box
 * is ticked (the server keeps the stored one otherwise).
 */
export function emailFormToAuthConfig(form: EmailFormState): Record<string, unknown> {
  return {
    username: form.username.trim(),
    password: form.password,
    ...(form.separateSmtpLogin
      ? { smtpUsername: form.smtpUsername.trim(), smtpPassword: form.smtpPassword }
      : {}),
  };
}

/** Whether the login part of the form was touched (connector page). */
export function emailLoginEdited(form: EmailFormState): boolean {
  return !!(form.username.trim() || form.password || form.separateSmtpLogin);
}

/** The form for an existing connector. The login is not sent to the browser, so it starts empty. */
export function emailFormFromConfig(config: unknown): EmailFormState {
  const email = ((config as { email?: Record<string, unknown> } | null)?.email ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback);
  const sec = (v: unknown, fallback: MailSecurity): MailSecurity =>
    v === 'tls' || v === 'starttls' || v === 'none' ? v : fallback;
  const saveSent = email.saveSent === 'always' || email.saveSent === 'never' ? email.saveSent : 'auto';
  return {
    ...EMPTY_EMAIL_FORM,
    imapHost: str(email.imapHost),
    imapPort: str(email.imapPort, '993'),
    imapSecurity: sec(email.imapSecurity, 'tls'),
    smtpHost: str(email.smtpHost),
    smtpPort: str(email.smtpPort, '465'),
    smtpSecurity: sec(email.smtpSecurity, 'tls'),
    fromAddress: str(email.fromAddress),
    fromName: str(email.fromName),
    sentFolder: str(email.sentFolder),
    draftsFolder: str(email.draftsFolder),
    saveSent,
    allowSelfSigned: email.allowSelfSigned === true || email.allowSelfSigned === 'true',
  };
}

const inputClass =
  'h-9 w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';
const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-[var(--text)]';
const hintClass = 'mt-1 text-[11.5px] text-[var(--text-3)]';

export function EmailSettingsFields({
  value,
  onChange,
  isCloud,
  existing = false,
}: {
  value: EmailFormState;
  onChange: (next: EmailFormState) => void;
  /** Cloud: no plaintext, no self-signed certificates. */
  isCloud: boolean;
  /** Editing a saved connector: empty passwords keep the stored ones. */
  existing?: boolean;
}) {
  const t = useTranslations('emailSettings');
  const set = <K extends keyof EmailFormState>(key: K, v: EmailFormState[K]) => onChange({ ...value, [key]: v });
  const securityOptions = [
    { value: 'tls', label: t('security.tls') },
    { value: 'starttls', label: t('security.starttls') },
    ...(isCloud ? [] : [{ value: 'none', label: t('security.none') }]),
  ];
  const setPort = (kind: 'imap' | 'smtp', port: string) => {
    const security = securityForPort(kind, port.trim());
    onChange({
      ...value,
      [`${kind}Port`]: port,
      ...(security ? { [`${kind}Security`]: security } : {}),
    } as EmailFormState);
  };

  return (
    <div className="flex flex-col gap-[15px]" data-testid="email-settings">
      {!existing && (
        <div>
          <label className={labelClass}>{t('provider')}</label>
          <AppSelect
            value=""
            onValueChange={(id) => {
              const p = PROVIDERS.find((x) => x.id === id);
              if (!p) return;
              onChange({
                ...value,
                imapHost: p.imap,
                imapPort: p.imapPort,
                imapSecurity: securityForPort('imap', p.imapPort) ?? 'tls',
                smtpHost: p.smtp,
                smtpPort: p.smtpPort,
                smtpSecurity: securityForPort('smtp', p.smtpPort) ?? 'tls',
              });
            }}
            className={inputClass}
            options={[{ value: '', label: t('providerPlaceholder') }, ...PROVIDERS.map((p) => ({ value: p.id, label: p.label }))]}
          />
          <p className={hintClass}>{t('providerHint')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_90px_150px]">
        <div>
          <label className={labelClass}>{t('imapHost')}</label>
          <input
            type="text"
            value={value.imapHost}
            onChange={(e) => set('imapHost', e.target.value)}
            placeholder="imap.example.com"
            className={cn(inputClass, 'font-mono text-[13px]')}
            required
          />
        </div>
        <div>
          <label className={labelClass}>{t('port')}</label>
          <input
            type="text"
            inputMode="numeric"
            value={value.imapPort}
            onChange={(e) => setPort('imap', e.target.value)}
            className={cn(inputClass, 'font-mono text-[13px]')}
          />
        </div>
        <div>
          <label className={labelClass}>{t('securityLabel')}</label>
          <AppSelect
            value={value.imapSecurity}
            onValueChange={(v) => set('imapSecurity', v as MailSecurity)}
            className={inputClass}
            options={securityOptions}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_90px_150px]">
        <div>
          <label className={labelClass}>{t('smtpHost')}</label>
          <input
            type="text"
            value={value.smtpHost}
            onChange={(e) => set('smtpHost', e.target.value)}
            placeholder="smtp.example.com"
            className={cn(inputClass, 'font-mono text-[13px]')}
          />
        </div>
        <div>
          <label className={labelClass}>{t('port')}</label>
          <input
            type="text"
            inputMode="numeric"
            value={value.smtpPort}
            onChange={(e) => setPort('smtp', e.target.value)}
            className={cn(inputClass, 'font-mono text-[13px]')}
          />
        </div>
        <div>
          <label className={labelClass}>{t('securityLabel')}</label>
          <AppSelect
            value={value.smtpSecurity}
            onValueChange={(v) => set('smtpSecurity', v as MailSecurity)}
            className={inputClass}
            options={securityOptions}
          />
        </div>
      </div>
      <p className={cn(hintClass, '-mt-2')}>{t('smtpHint')}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>{t('username')}</label>
          <input
            type="text"
            autoComplete="off"
            value={value.username}
            onChange={(e) => set('username', e.target.value)}
            placeholder={existing ? t('keepUsername') : 'anna@example.com'}
            className={inputClass}
            required={!existing}
          />
        </div>
        <div>
          <label className={labelClass}>{t('password')}</label>
          <input
            type="password"
            autoComplete="new-password"
            value={value.password}
            onChange={(e) => set('password', e.target.value)}
            placeholder={existing ? t('keepPassword') : ''}
            className={inputClass}
            required={!existing}
          />
        </div>
      </div>
      <p className={cn(hintClass, '-mt-2')}>{t('passwordHint')}</p>

      <label className="flex items-center gap-2 text-[13px] text-[var(--text)]">
        <input type="checkbox" checked={value.separateSmtpLogin} onChange={(e) => set('separateSmtpLogin', e.target.checked)} />
        {t('separateSmtpLogin')}
      </label>
      {value.separateSmtpLogin && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass}>{t('smtpUsername')}</label>
            <input
              type="text"
              autoComplete="off"
              value={value.smtpUsername}
              onChange={(e) => set('smtpUsername', e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>{t('smtpPassword')}</label>
            <input
              type="password"
              autoComplete="new-password"
              value={value.smtpPassword}
              onChange={(e) => set('smtpPassword', e.target.value)}
              placeholder={existing ? t('keepPassword') : ''}
              className={inputClass}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass}>{t('fromAddress')}</label>
          <input
            type="email"
            value={value.fromAddress}
            onChange={(e) => set('fromAddress', e.target.value)}
            placeholder={t('fromAddressPlaceholder')}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>{t('fromName')}</label>
          <input type="text" value={value.fromName} onChange={(e) => set('fromName', e.target.value)} className={inputClass} />
        </div>
      </div>

      <details className="rounded-[9px] border border-[var(--border)] px-3 py-2">
        <summary className="cursor-pointer text-[12.5px] font-medium text-[var(--text-2)]">{t('advanced')}</summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>{t('sentFolder')}</label>
              <input
                type="text"
                value={value.sentFolder}
                onChange={(e) => set('sentFolder', e.target.value)}
                placeholder={t('autoDetected')}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('draftsFolder')}</label>
              <input
                type="text"
                value={value.draftsFolder}
                onChange={(e) => set('draftsFolder', e.target.value)}
                placeholder={t('autoDetected')}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>{t('saveSent')}</label>
            <AppSelect
              value={value.saveSent}
              onValueChange={(v) => set('saveSent', v as EmailFormState['saveSent'])}
              className={inputClass}
              options={[
                { value: 'auto', label: t('saveSentAuto') },
                { value: 'always', label: t('saveSentAlways') },
                { value: 'never', label: t('saveSentNever') },
              ]}
            />
          </div>
          {!isCloud && (
            <label className="flex items-start gap-2 text-[13px] text-[var(--text)]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={value.allowSelfSigned}
                onChange={(e) => set('allowSelfSigned', e.target.checked)}
              />
              <span>
                {t('allowSelfSigned')}
                <span className="block text-[11.5px] text-[var(--text-3)]">{t('allowSelfSignedHint')}</span>
              </span>
            </label>
          )}
        </div>
      </details>

      <p className={hintClass}>{isCloud ? t('cloudNote') : t('selfHostedNote')}</p>
    </div>
  );
}
