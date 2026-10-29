'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { users, server, sso, social, knowledgeGraph, ApiError, type LinkableProvider, type MemberLearning, type SocialConnection } from '@/lib/api';
import { ProviderMark } from '@/components/provider-mark';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/badge';
import { LanguageSwitcher } from '@/components/language-switcher';

const AUTH_MODES = ['none', 'legacy', 'oauth2', 'both'] as const;

export default function SettingsPage() {
  const toast = useToast();
  const t = useTranslations('settingsProfile');
  const locale = useLocale();

  const { token, user, updateUser, logout } = useAuth();
  const [profileName, setProfileName] = useState(user?.name || '');
  const [profileMsg, setProfileMsg] = useState('');
  // Both messages below are only ever errors; the flags keep their colour
  // from depending on the English "Error" prefix.
  const [profileMsgIsError, setProfileMsgIsError] = useState(false);
  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState('');
  const [passwordMsgIsError, setPasswordMsgIsError] = useState(false);
  const [mcpAuthMode, setMcpAuthMode] = useState('');
  const [oauthEndpoints, setOauthEndpoints] = useState<Record<string, string> | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  // Cloud only: onboarding tips and offers by email (the drip, win-back).
  const [isCloud, setIsCloud] = useState(false);
  const [marketingOptOut, setMarketingOptOut] = useState<boolean | null>(null);
  const [marketingSaving, setMarketingSaving] = useState(false);
  const [learning, setLearning] = useState<MemberLearning | null>(null);
  const [learningSaving, setLearningSaving] = useState(false);

  // Delete account
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // A passwordless (social) account confirms deletion with a fresh sign-in.
  const [deleteNeedsReauth, setDeleteNeedsReauth] = useState(false);
  const [blockingOrgs, setBlockingOrgs] = useState<{ id: string; name: string }[] | null>(null);

  // Connected accounts
  const [linkable, setLinkable] = useState<LinkableProvider[]>([]);
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  // Cloud social sign-in (Google, Microsoft, GitHub).
  const [socialConnections, setSocialConnections] = useState<SocialConnection[]>([]);
  const [hasPassword, setHasPassword] = useState(true);

  // Load server info
  useEffect(() => {
    server.info().then((info) => {
      setMcpAuthMode(info.mcpAuthMode);
      setOauthEndpoints(info.oauthEndpoints);
      setServerUrl(info.serverUrl);
      setIsCloud(info.deploymentMode === 'cloud');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isCloud || !token) return;
    users
      .onboardingState(token)
      .then((st) => setMarketingOptOut(st.emailMarketingOptOut))
      .catch(() => setMarketingOptOut(null));
  }, [isCloud, token]);

  useEffect(() => {
    if (!token) return;
    knowledgeGraph.learning
      .me(token)
      .then(setLearning)
      .catch(() => setLearning(null));
  }, [token]);

  const handleLearningOptOut = async (optOut: boolean, clearIntents = false) => {
    if (!token) return;
    setLearningSaving(true);
    try {
      const res = await knowledgeGraph.learning.setMine(token, { optOut, clearIntents });
      setLearning(res);
      toast.show({
        tone: 'success',
        title: clearIntents
          ? t('toast.requestsErased', { count: res.intentsCleared })
          : optOut
            ? t('toast.learningOptedOut')
            : t('toast.learningReset'),
      });
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.couldNotSave'), description: err?.message });
    } finally {
      setLearningSaving(false);
    }
  };

  const handleMarketingToggle = async (wantsEmails: boolean) => {
    if (!token) return;
    setMarketingSaving(true);
    try {
      const st = await users.updateOnboardingState({ emailMarketingOptOut: !wantsEmails }, token);
      setMarketingOptOut(st.emailMarketingOptOut);
      toast.show({ tone: 'success', title: wantsEmails ? t('toast.tipsOn') : t('toast.tipsOff') });
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.couldNotSave'), description: err?.message });
    } finally {
      setMarketingSaving(false);
    }
  };

  const loadLinkable = () => {
    if (!token) return;
    // Silently empty when the workspace has no provider: this card should not
    // announce a feature the workspace has not configured.
    sso.myProviders(token).then(setLinkable).catch(() => setLinkable([]));
  };

  const loadSocial = () => {
    if (!token || !isCloud) return;
    social
      .identities(token)
      .then((r) => {
        setSocialConnections(r.providers);
        setHasPassword(r.hasPassword);
      })
      .catch(() => setSocialConnections([]));
  };

  useEffect(() => {
    loadLinkable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    loadSocial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isCloud]);

  // The callback lands back here with the outcome in the query string. Read it
  // once and strip it, so a refresh does not replay the same toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('linked');
    const linkError = params.get('linkError');
    if (!linked && !linkError) return;

    if (linkError) {
      toast.show({ tone: 'error', title: t('toast.couldNotConnect'), description: linkError });
    } else {
      toast.show({ tone: 'success', title: t('toast.accountConnected') });
      loadLinkable();
      loadSocial();
    }
    window.history.replaceState({}, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLink = async (p: LinkableProvider) => {
    if (!token) return;
    setLinkBusy(p.id);
    try {
      const { authorizationUrl } = await sso.startLink(p.id, '/settings', token);
      // Top-level navigation, not fetch: the provider needs to render its own
      // sign-in page to the user.
      window.location.assign(authorizationUrl);
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.couldNotConnect'), description: err.message });
      setLinkBusy(null);
    }
  };

  const handleUnlink = async (p: LinkableProvider) => {
    if (!token) return;
    if (
      !confirm(
        t('confirmUnlink', { name: p.name }),
      )
    )
      return;
    setLinkBusy(p.id);
    try {
      await sso.unlink(p.id, token);
      toast.show({ tone: 'success', title: t('toast.accountDisconnected') });
      loadLinkable();
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.couldNotDisconnect'), description: err.message });
    } finally {
      setLinkBusy(null);
    }
  };

  const handleSocialLink = async (p: SocialConnection) => {
    if (!token) return;
    setLinkBusy(`social:${p.id}`);
    try {
      const { authorizationUrl } = await social.startLink(p.id, '/settings', token);
      window.location.assign(authorizationUrl);
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.couldNotConnect'), description: err.message });
      setLinkBusy(null);
    }
  };

  const handleSocialUnlink = async (p: SocialConnection) => {
    if (!token) return;
    if (!confirm(t('confirmSocialUnlink', { name: p.name }))) return;
    setLinkBusy(`social:${p.id}`);
    try {
      await social.unlink(p.id, token);
      toast.show({ tone: 'success', title: t('toast.accountDisconnected') });
      loadSocial();
    } catch (err: any) {
      toast.show({ tone: 'error', title: t('toast.couldNotDisconnect'), description: err.message });
    } finally {
      setLinkBusy(null);
    }
  };

  const handleSaveProfile = async () => {
    if (!token) return;
    try {
      await users.updateProfile({ name: profileName }, token);
      updateUser({ name: profileName });
      setProfileMsg('');
      toast.show({ tone: 'success', title: t('toast.profileUpdated') });
    } catch (err: any) {
      const message = err?.message || t('couldNotUpdateProfile');
      setProfileMsgIsError(true);
      setProfileMsg(t('error', { message }));
      toast.show({ tone: 'error', title: t('toast.profileUpdateFailed'), description: message });
    }
  };

  const handleDeleteAccount = async () => {
    if (!token) return;
    if (deleteConfirm !== 'DELETE') return;
    setDeleting(true);
    setDeleteError(null);
    setBlockingOrgs(null);
    try {
      await users.deleteSelf(
        hasPassword ? { password: deletePassword, confirm: 'DELETE' } : { confirm: 'DELETE' },
        token,
      );
      logout();
    } catch (err: any) {
      if (err instanceof ApiError) {
        if (err.status === 403 && err.body?.code === 'reauth_required') {
          setDeleteNeedsReauth(true);
          setDeleteError(err.message);
        } else if (err.status === 401) {
          setDeleteError(hasPassword ? t('incorrectPassword') : err.message || t('deleteFailed'));
        } else if (err.status === 409 && Array.isArray(err.body?.blockingOrganizations)) {
          setBlockingOrgs(err.body.blockingOrganizations);
          setDeleteError(err.body?.error || t('onlyAdmin'));
        } else {
          setDeleteError(err.message || t('deleteFailed'));
        }
      } else {
        setDeleteError(err?.message || t('deleteFailed'));
      }
      setDeleting(false);
    }
  };

  /** Sign in again with a connected provider, then come back to this dialog. */
  const reauthForDelete = async () => {
    const provider = socialConnections.find((p) => p.connected);
    if (!provider) return;
    try {
      const { authorizationUrl } = await social.start(provider.id, '/settings?delete=1');
      window.location.assign(authorizationUrl);
    } catch (err: any) {
      setDeleteError(err?.message || t('couldNotStartSignIn'));
    }
  };

  // Back from that sign-in: reopen the dialog.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('delete') !== '1') return;
    setDeleteOpen(true);
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const resetDeleteDialog = () => {
    setDeleteOpen(false);
    setDeleteNeedsReauth(false);
    setDeletePassword('');
    setDeleteConfirm('');
    setDeleteError(null);
    setBlockingOrgs(null);
    setDeleting(false);
  };

  const handleChangePassword = async () => {
    if (!token) return;
    if (newPassword !== confirmNewPassword) {
      setPasswordMsgIsError(true);
      setPasswordMsg(t('error', { message: t('toast.passwordsDoNotMatch') }));
      toast.show({ tone: 'error', title: t('toast.passwordsDoNotMatch') });
      return;
    }
    try {
      const result = await users.changePassword({ currentPassword, newPassword }, token);
      if (result.error) {
        setPasswordMsgIsError(true);
        setPasswordMsg(t('error', { message: result.error }));
        toast.show({ tone: 'error', title: t('toast.passwordChangeFailed'), description: result.error });
      } else {
        setPasswordMsg('');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
        toast.show({ tone: 'success', title: t('toast.passwordChanged') });
      }
    } catch (err: any) {
      const message = err?.message || t('couldNotChangePassword');
      setPasswordMsgIsError(true);
      setPasswordMsg(t('error', { message }));
      toast.show({ tone: 'error', title: t('toast.passwordChangeFailed'), description: message });
    }
  };

  const inputClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--brand)]';
  const inputDisabledClass =
    'w-full h-9 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text-3)]';
  const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)] mb-1';
  const codeTag = (chunks: React.ReactNode) => (
    <code className="bg-[var(--surface-3)] px-1 rounded font-mono">{chunks}</code>
  );

  return (
    <div className="space-y-6">
      {/* Profile */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-4">{t('profile.title')}</h3>
        <div className="space-y-4 max-w-md">
          <div>
            <label htmlFor="settings-profile-email" className={labelClass}>{t('profile.email')}</label>
            <input id="settings-profile-email" name="email" autoComplete="email" type="text" value={user?.email || ''} disabled className={inputDisabledClass} />
          </div>
          <div>
            <label htmlFor="settings-profile-name" className={labelClass}>{t('profile.name')}</label>
            <input id="settings-profile-name" name="name" autoComplete="name" type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label htmlFor="settings-profile-role" className={labelClass}>{t('profile.role')}</label>
            <input id="settings-profile-role" type="text" value={user?.role || ''} disabled className={inputDisabledClass} />
          </div>
          <LanguageSwitcher />
          {profileMsg && (
            <p className={`text-sm ${profileMsgIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {profileMsg}
            </p>
          )}
          <Button onClick={handleSaveProfile}>{t('profile.save')}</Button>
        </div>
      </Card>

      {/* Email preferences (Cloud). The unsubscribe link in tips emails also leads here. */}
      {isCloud && marketingOptOut !== null && (
        <Card id="email-preferences" className="p-[22px] scroll-mt-6">
          <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('emailPrefs.title')}</h3>
          <label className="flex items-start gap-2.5 cursor-pointer max-w-md">
            <input
              type="checkbox"
              checked={!marketingOptOut}
              disabled={marketingSaving}
              onChange={(e) => handleMarketingToggle(e.target.checked)}
              className="mt-0.5 accent-[var(--brand)]"
            />
            <span className="text-sm text-[var(--text-2)]">
              <span className="font-medium text-[var(--text)]">{t('emailPrefs.label')}</span>
              <br />
              {t('emailPrefs.body')}
            </span>
          </label>
        </Card>
      )}

      {/* Skill learning: shown once it can concern this user (workspace switch
          on, an admin turned it on for them, or they already opted out). */}
      {learning && (learning.workspaceDefault || learning.mode === 'on' || learning.optOut) && (
        <Card className="p-[22px]">
          <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('learning.title')}</h3>
          <p className="text-sm text-[var(--text-2)] mb-3 max-w-xl">
            {learning.effective
              ? t('learning.effective')
              : learning.optOut
                ? t('learning.optedOut')
                : t('learning.adminOff')}
          </p>
          <label className="flex items-start gap-2.5 cursor-pointer max-w-md">
            <input
              type="checkbox"
              checked={!learning.optOut}
              disabled={learningSaving}
              onChange={(e) => handleLearningOptOut(!e.target.checked)}
              className="mt-0.5 accent-[var(--brand)]"
            />
            <span className="text-sm text-[var(--text-2)]">
              <span className="font-medium text-[var(--text)]">{t('learning.label')}</span>
              <br />
              {t('learning.body')}
            </span>
          </label>
          {learning.optOut && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={learningSaving}
              onClick={() => handleLearningOptOut(true, true)}
            >
              {t('learning.erase')}
            </Button>
          )}
        </Card>
      )}

      {/* Change Password */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-4">{t('password.title')}</h3>
        <div className="space-y-4 max-w-md">
          <div>
            <label htmlFor="settings-current-password" className={labelClass}>{t('password.current')}</label>
            <input
              id="settings-current-password"
              name="current-password"
              autoComplete="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="settings-new-password" className={labelClass}>{t('password.new')}</label>
            <input
              id="settings-new-password"
              name="new-password"
              autoComplete="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t('password.newPlaceholder')}
              minLength={8}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="settings-confirm-new-password" className={labelClass}>{t('password.confirm')}</label>
            <input
              id="settings-confirm-new-password"
              name="confirm-new-password"
              autoComplete="new-password"
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder={t('password.confirmPlaceholder')}
              minLength={8}
              className={inputClass}
            />
          </div>
          {passwordMsg && (
            <p className={`text-sm ${passwordMsgIsError ? 'text-[var(--danger)]' : 'text-[var(--ok)]'}`}>
              {passwordMsg}
            </p>
          )}
          <Button
            onClick={handleChangePassword}
            disabled={!currentPassword || !newPassword || newPassword.length < 8}
          >
            {t('password.submit')}
          </Button>
        </div>
      </Card>

      {/* Connected accounts */}
      {linkable.length > 0 && (
        <Card className="p-[22px]">
          <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('linked.title')}</h3>
          <p className="text-sm text-[var(--text-2)] mb-4">
            {t('linked.body')}
          </p>
          <div className="space-y-2 max-w-md">
            {linkable.map((p) => (
              <div
                key={p.id}
                className="rounded-[9px] border border-[var(--border)] p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--text)]">{p.name}</div>
                  <div className="text-[11.5px] text-[var(--text-3)] mt-0.5">
                    {p.linked
                      ? p.lastLoginAt
                        ? t('linked.connectedLastUsed', { date: new Date(p.lastLoginAt).toLocaleDateString(locale) })
                        : t('linked.connected')
                      : t('linked.notConnected')}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={p.linked ? 'secondary' : 'primary'}
                  disabled={linkBusy === p.id}
                  onClick={() => (p.linked ? handleUnlink(p) : handleLink(p))}
                >
                  {linkBusy === p.id
                    ? t('linked.working')
                    : p.linked
                      ? t('linked.disconnect')
                      : t('linked.connect')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Sign-in methods (Cloud social sign-in) */}
      {isCloud && socialConnections.length > 0 && (
        <Card className="p-[22px]" data-testid="sign-in-methods">
          <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('social.title')}</h3>
          <p className="text-sm text-[var(--text-2)] mb-4">
            {t('social.body')}
          </p>
          {!hasPassword && (
            <p className="text-sm text-[var(--text-2)] mb-4">
              {t.rich('social.noPassword', {
                link: (chunks) => (
                  <Link href="/forgot-password" className="text-[var(--brand)] underline">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
          <div className="space-y-2 max-w-md">
            {socialConnections.map((p) => (
              <div
                key={p.id}
                className="rounded-[9px] border border-[var(--border)] p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex items-center gap-2.5">
                  <ProviderMark type={p.id} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--text)]">{p.name}</div>
                    <div className="text-[11.5px] text-[var(--text-3)] mt-0.5 truncate">
                      {p.connected
                        ? [p.email, p.lastLoginAt ? t('social.lastUsed', { date: new Date(p.lastLoginAt).toLocaleDateString(locale) }) : null]
                            .filter(Boolean)
                            .join(' · ') || t('linked.connected')
                        : t('linked.notConnected')}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={p.connected ? 'secondary' : 'primary'}
                  disabled={linkBusy === `social:${p.id}`}
                  onClick={() => (p.connected ? handleSocialUnlink(p) : handleSocialLink(p))}
                >
                  {linkBusy === `social:${p.id}` ? t('linked.working') : p.connected ? t('linked.disconnect') : t('linked.connect')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* MCP Auth */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('mcpAuth.title')}</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          {t('mcpAuth.body')}
        </p>
        <div className="space-y-4 max-w-lg">
          <div>
            <label className={labelClass}>{t('mcpAuth.method')}</label>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-9 flex items-center rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text-2)]">
                {(AUTH_MODES as readonly string[]).includes(mcpAuthMode)
                  ? t(`authModes.${mcpAuthMode as (typeof AUTH_MODES)[number]}`)
                  : mcpAuthMode || t('mcpAuth.loading')}
              </div>
              {(mcpAuthMode === 'oauth2' || mcpAuthMode === 'both') && (
                <StatusPill tone="success" dot="var(--ok)">{t('mcpAuth.active')}</StatusPill>
              )}
            </div>
          </div>

          {/* OAuth2 info */}
          {(mcpAuthMode === 'oauth2' || mcpAuthMode === 'both') && oauthEndpoints && (
            <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-4 space-y-3">
              <h4 className="text-sm font-semibold text-[var(--text)]">{t('mcpAuth.oauthTitle')}</h4>
              <div className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs font-mono text-[var(--text)] sm:grid-cols-[auto_minmax(0,1fr)]">
                <span className="text-[var(--text-3)]">Discovery:</span>
                <span className="break-all sm:mb-0 mb-1.5">{serverUrl}{oauthEndpoints.wellKnown}</span>
                <span className="text-[var(--text-3)]">Authorize:</span>
                <span className="break-all sm:mb-0 mb-1.5">{serverUrl}{oauthEndpoints.authorize}</span>
                <span className="text-[var(--text-3)]">Token:</span>
                <span className="break-all sm:mb-0 mb-1.5">{serverUrl}{oauthEndpoints.token}</span>
                <span className="text-[var(--text-3)]">Register:</span>
                <span className="break-all">{serverUrl}{oauthEndpoints.register}</span>
              </div>
              <p className="text-xs text-[var(--text-3)]">
                {t('mcpAuth.oauthNote')}
              </p>
            </div>
          )}

          {/* Legacy info */}
          {(mcpAuthMode === 'legacy' || mcpAuthMode === 'both') && (
            <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-4 space-y-2">
              <h4 className="text-sm font-semibold text-[var(--text)]">{t('mcpAuth.legacyTitle')}</h4>
              <p className="text-xs text-[var(--text-3)]">
                {t.rich('mcpAuth.legacyBody', { code: codeTag })}
              </p>
            </div>
          )}

          <p className="text-xs text-[var(--text-3)]">
            {t.rich('mcpAuth.modeNote', { code: codeTag })}
          </p>
        </div>
      </Card>

      {/* MCP API Keys note */}
      <Card className="p-[22px]">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">{t('apiKeys.title')}</h3>
        <p className="text-sm text-[var(--text-2)]">
          {t.rich('apiKeys.body', {
            link: (chunks) => (
              <a href="/mcp-server" className="text-[var(--brand)] hover:underline">{chunks}</a>
            ),
          })}
        </p>
      </Card>

      {/* Danger Zone */}
      <Card className="p-[22px] border-[var(--danger)]/30 bg-[var(--t-danger-bg)]">
        <h3 className="text-sm font-semibold text-[var(--danger)] mb-2">{t('danger.title')}</h3>
        <p className="text-sm text-[var(--text-2)] mb-4">
          {t('danger.body')}
        </p>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          {t('danger.button')}
        </Button>
      </Card>

      <Dialog.Root open={deleteOpen} onOpenChange={(open) => { if (!open) resetDeleteDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
            <Dialog.Title className="text-base font-semibold text-[var(--text)] mb-2">{t('deleteDialog.title')}</Dialog.Title>
            <Dialog.Description className="text-sm text-[var(--text-2)] mb-4">
              {t.rich(hasPassword ? 'deleteDialog.descPassword' : 'deleteDialog.descNoPassword', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </Dialog.Description>

            {blockingOrgs && blockingOrgs.length > 0 && (
              <div className="mb-4 p-3 rounded-[9px] border border-[var(--danger)]/30 bg-[var(--t-danger-bg)] text-sm text-[var(--t-danger-fg)]">
                <p className="font-medium mb-1">{t('deleteDialog.blockingTitle')}</p>
                <ul className="list-disc pl-5 space-y-0.5">
                  {blockingOrgs.map((o) => (
                    <li key={o.id}>{o.name}</li>
                  ))}
                </ul>
                <p className="mt-2">
                  {t('deleteDialog.blockingHint')}
                </p>
              </div>
            )}

            <div className="space-y-3">
              {hasPassword && (
                <div>
                  <label className={labelClass}>{t('deleteDialog.password')}</label>
                  <input
                    type="password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    className={inputClass}
                  />
                </div>
              )}
              <div>
                <label className={labelClass}>
                  {t.rich('deleteDialog.typeConfirm', { code: (chunks) => <code className="font-mono">{chunks}</code> })}
                </label>
                <input
                  type="text"
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                />
              </div>
              {deleteError && !blockingOrgs && (
                <p className="text-sm text-[var(--danger)]">{deleteError}</p>
              )}
              {deleteNeedsReauth && socialConnections.some((p) => p.connected) && (
                <Button variant="secondary" onClick={reauthForDelete}>
                  {t('deleteDialog.reauth', { provider: socialConnections.find((p) => p.connected)?.name ?? '' })}
                </Button>
              )}
            </div>

            <div className="flex gap-2 justify-end mt-6">
              <Dialog.Close asChild>
                <Button variant="secondary">{t('deleteDialog.cancel')}</Button>
              </Dialog.Close>
              <Button
                variant="danger"
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirm !== 'DELETE' || (hasPassword && !deletePassword)}
              >
                {deleting ? t('deleteDialog.deleting') : t('deleteDialog.submit')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
