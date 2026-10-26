'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { auth } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/logo-icon';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/** Small AnythingMCP brand mark for the top of pre-auth cards. */
function BrandMark() {
  return (
    <div className="flex items-center justify-center gap-2">
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-[var(--brand-tint)] text-[var(--brand)]">
        <LogoIcon size={20} />
      </span>
      <span className="text-base font-semibold text-[var(--text)]">
        Anything<span className="text-[var(--brand)]">MCP</span>
      </span>
    </div>
  );
}

const inputClass =
  'w-full h-10 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] ' +
  'placeholder:text-[var(--text-3)] outline-none transition-colors ' +
  'focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand-ring)]';

function AcceptInviteContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { login, token: sessionToken, user: sessionUser } = useAuth();
  const token = searchParams.get('token') || '';
  const t = useTranslations('acceptInvite');

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [exists, setExists] = useState(false);
  const [ssoOnly, setSsoOnly] = useState(false);
  const [valid, setValid] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setValid(false);
      return;
    }
    auth
      .verifyInvite(token)
      .then((data) => {
        setEmail(data.email);
        setRole(data.role);
        setExists(!!data.exists);
        setSsoOnly(!!data.ssoOnly);
        setValid(true);
      })
      .catch((err) => {
        setError(err.message);
        setValid(false);
      });
  }, [token]);

  // True when the person viewing this page is already signed in as exactly the
  // invited address: they can accept in one click, no password needed.
  const signedInAsInvitee =
    !!sessionUser && !!email && sessionUser.email?.toLowerCase() === email.toLowerCase();

  const accept = async (payload: { password?: string; name?: string }) => {
    setSubmitting(true);
    setError('');
    try {
      const result = await auth.acceptInvite(
        { token, ...payload },
        signedInAsInvitee ? sessionToken ?? undefined : undefined,
      );
      login(result.accessToken, result.user);
      router.push('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError(t('errors.mismatch'));
      return;
    }
    await accept({ password, name });
  };

  const handleJoinExisting = async (e: React.FormEvent) => {
    e.preventDefault();
    // When signed in as the invitee, no password is sent — the session proves
    // ownership server-side.
    await accept(signedInAsInvitee ? {} : { password });
  };

  return (
    <div className="w-full max-w-md">
      {valid === false ? (
        <Card className="p-6 text-center">
          <div className="flex justify-center mb-4">
            <BrandMark />
          </div>
          <div className="rounded-[9px] px-3 py-3 bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]">
            <h2 className="font-semibold mb-1">{t('invalidTitle')}</h2>
            <p className="text-sm">{error || (token ? '' : t('errors.noToken'))}</p>
          </div>
          <a href="/login" className="text-sm text-[var(--brand)] hover:underline mt-4 inline-block">
            {t('goToLogin')}
          </a>
        </Card>
      ) : (
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">{t('title')}</h1>
            <p className="text-[var(--text-2)] text-sm mt-1">
              {exists ? t('subtitleExisting') : t('subtitleNew')}
            </p>
          </div>

          {valid === null && (
            <p className="text-center text-[var(--text-2)]">{t('verifying')}</p>
          )}

          {valid === true && (
            <>
              <div className="rounded-[9px] px-3 py-2.5 bg-[var(--t-info-bg)] text-[var(--t-info-fg)] mb-4">
                <p className="text-sm">
                  {t.rich('invitedAs', { role, email, strong: (chunks) => <strong>{chunks}</strong> })}
                </p>
              </div>

              {/* SSO-only account that the viewer is not signed into: they must
                  authenticate with their provider before joining. */}
              {exists && ssoOnly && !signedInAsInvitee ? (
                <div className="space-y-4">
                  <p className="text-sm text-[var(--text-2)]">
                    {t('ssoOnly')}
                  </p>
                  <a href="/login">
                    <Button className="w-full" size="lg">
                      {t('goToSignIn')}
                    </Button>
                  </a>
                </div>
              ) : exists ? (
                // Existing local account: prove ownership (or one click when
                // already signed in as this address).
                <form onSubmit={handleJoinExisting} className="space-y-4">
                  {!signedInAsInvitee && (
                    <div>
                      <label className="block text-sm font-medium mb-1 text-[var(--text)]">
                        {t('yourPassword')}
                      </label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoFocus
                        placeholder={t('yourPasswordPlaceholder')}
                        className={inputClass}
                      />
                      <p className="mt-1.5 text-xs text-[var(--text-3)]">
                        {t('confirmIdentity')}
                      </p>
                    </div>
                  )}
                  {signedInAsInvitee && (
                    <p className="text-sm text-[var(--text-2)]">
                      {t.rich('signedInAs', { email, strong: (chunks) => <strong>{chunks}</strong> })}
                    </p>
                  )}
                  {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
                  <Button
                    type="submit"
                    disabled={submitting || (!signedInAsInvitee && !password)}
                    className="w-full"
                    size="lg"
                  >
                    {submitting ? t('joining') : t('join')}
                  </Button>
                </form>
              ) : (
                // Brand-new account.
                <form onSubmit={handleCreate} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1 text-[var(--text)]">
                      {t('name')}
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      className={inputClass}
                      placeholder={t('namePlaceholder')}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1 text-[var(--text)]">{t('email')}</label>
                    <input
                      type="email"
                      value={email}
                      disabled
                      className="w-full h-10 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] opacity-70"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1 text-[var(--text)]">
                      {t('password')}
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      placeholder={t('passwordPlaceholder')}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1 text-[var(--text)]">
                      {t('confirmPassword')}
                    </label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={8}
                      placeholder={t('confirmPasswordPlaceholder')}
                      className={inputClass}
                    />
                  </div>

                  {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

                  <Button
                    type="submit"
                    disabled={submitting || !name || !password || password.length < 8}
                    className="w-full"
                    size="lg"
                  >
                    {submitting ? t('creating') : t('create')}
                  </Button>
                </form>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}

export default function AcceptInvitePage() {
  const t = useTranslations('acceptInvite');
  return (
    <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center px-4">
      <Suspense fallback={<p className="text-[var(--text-2)]">{t('loading')}</p>}>
        <AcceptInviteContent />
      </Suspense>
    </div>
  );
}
