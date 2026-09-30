'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, auth, license, server, sso, type SsoProviderButton, recoveryCodes as recoveryApi } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/toast';
import { buildPricingUrl } from '@/lib/marketing';
import { LogoIcon } from '@/components/logo-icon';
import { ProviderMark } from '@/components/provider-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { safeRedirect } from '@/lib/safe-redirect';
import { captureSignupAttribution, clearSignupAttribution, getSignupAttribution } from '@/lib/attribution';
import { pushSignUpVerified } from '@/lib/conversion';
import {
  cardTrialEligible,
  parsePlanIntent,
  readCardTrialPrompt,
  savePlanIntent,
  writeCardTrialPrompt,
} from '@/lib/card-trial';

type SetupStep = 'auth' | 'verify-email' | 'check-inbox' | 'license-choice' | 'license-email-sent' | 'license-key' | 'trial-activated';

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

const alertDanger =
  'mb-4 rounded-[9px] px-3 py-2.5 text-sm bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]';
const alertSuccess =
  'mb-4 rounded-[9px] px-3 py-2.5 text-sm bg-[var(--t-success-bg)] text-[var(--t-success-fg)]';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState('');
  const [setupStep, setSetupStep] = useState<SetupStep>('auth');
  const [licenseKey, setLicenseKey] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [isFirstUserFlag, setIsFirstUserFlag] = useState(false);
  const [storedUser, setStoredUser] = useState<any>(null);
  const [resendMessage, setResendMessage] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [isCloudMode, setIsCloudMode] = useState(false);
  const [trialDaysLeft, setTrialDaysLeft] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const toast = useToast();

  const redirectTo = safeRedirect(searchParams.get('redirect'));
  const emailVerifiedParam = searchParams.get('emailVerified');
  const modeParam = searchParams.get('mode'); // 'register' or 'login'
  const ssoCode = searchParams.get('sso');
  const errorParam = searchParams.get('error');
  const planParam = searchParams.get('plan');
  const periodParam = searchParams.get('period');
  const [ssoProviders, setSsoProviders] = useState<SsoProviderButton[]>([]);
  const [ssoExchanging, setSsoExchanging] = useState(Boolean(ssoCode));

  useEffect(() => {
    server.info().then((info) => {
      setRegistrationEnabled(info.registrationEnabled);
      setIsCloudMode(info.deploymentMode === 'cloud');
      // Empty in cloud by design — see the comment on the backend endpoint.
      setSsoProviders(info.ssoProviders ?? []);
      if (!info.hasUsers) {
        setIsRegister(true);
      } else if (modeParam === 'register' && info.registrationEnabled) {
        setIsRegister(true);
      } else if (modeParam === 'login') {
        setIsRegister(false);
      }
    }).catch(() => {});
  }, [modeParam]);

  // Cloud only: note where this visitor came from, for the sign-up to carry.
  // Self-hosted instances record nothing.
  useEffect(() => {
    if (isCloudMode) captureSignupAttribution();
  }, [isCloudMode]);

  // Cloud only: the pricing page opens sign-up with the plan the visitor
  // picked (`?plan=cloud_team&period=yearly`). Kept in localStorage so it
  // survives email verification, which may happen days later in another tab,
  // and preselects that plan on the card-trial offer.
  useEffect(() => {
    if (!isCloudMode) return;
    const intent = parsePlanIntent(planParam, periodParam);
    if (intent) savePlanIntent(intent);
  }, [isCloudMode, planParam, periodParam]);

  /**
   * Cloud only: right after the trial starts, an admin headed for the
   * dashboard is offered the card trial (/start-trial) instead of the
   * "Trial activated" card, once. A sign-in on its way somewhere specific
   * (an OAuth consent, an install link) is left alone.
   */
  const offerCardTrial = (
    u: { id?: string; role?: string } | null | undefined,
    trial: { plan: string; expiresAt: string | null; trialDaysLeft: number },
  ): boolean => {
    if (!isCloudMode || redirectTo !== '/' || !u?.id) return false;
    const eligible = cardTrialEligible({
      isCloud: true,
      role: u.role,
      license: {
        plan: trial.plan,
        status: 'active',
        expiresAt: trial.expiresAt,
        trialDaysLeft: trial.trialDaysLeft,
      },
    });
    if (!eligible || readCardTrialPrompt(u.id) !== null) return false;
    writeCardTrialPrompt(u.id, 'shown');
    router.push('/start-trial');
    return true;
  };

  // Surface a failure the SSO callback redirected back with.
  useEffect(() => {
    if (errorParam) setError(errorParam);
  }, [errorParam]);

  // Trade the one-time code from the sign-in redirect for a session. The code
  // is single-use and lives 30 seconds; the token itself never travels in a URL.
  //
  // Guarded by a ref rather than the usual `cancelled` flag, because the code
  // is spent by the REQUEST, not by what we do with the response. Under React
  // StrictMode the effect runs twice: the first call burns the code, its
  // result is discarded as stale, and the second call reports "invalid or
  // expired" for a sign-in that actually succeeded. The same race can strand a
  // user on any remount. Recording the code before awaiting makes the exchange
  // happen at most once per code.
  const exchangedCode = useRef<string | null>(null);
  useEffect(() => {
    if (!ssoCode || exchangedCode.current === ssoCode) return;
    exchangedCode.current = ssoCode;
    (async () => {
      try {
        const result = await sso.exchange(ssoCode);
        if (!result.accessToken) {
          setError(result.error || 'Sign-in code is invalid or has expired');
          setSsoExchanging(false);
          return;
        }
        login(result.accessToken, result.user);
        router.replace(redirectTo);
      } catch (err: any) {
        setError(err.message || 'Sign-in failed');
        setSsoExchanging(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ssoCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let needsLicenseSetup = false;
      let result: { accessToken: string; user: any };
      if (isRegister) {
        // Validate password strength
        const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;
        if (!passwordRegex.test(password)) {
          setError('Password must be at least 8 characters and include uppercase, lowercase, number, and special character');
          setLoading(false);
          return;
        }
        // Validate confirm password
        if (password !== confirmPassword) {
          setError('Passwords do not match');
          setLoading(false);
          return;
        }
        if (!acceptTerms) {
          setError('You must accept the Terms of Use');
          setLoading(false);
          return;
        }
        // Captured on mount too; again here in case the form beat that.
        if (isCloudMode) captureSignupAttribution();
        const attribution = isCloudMode ? getSignupAttribution() : undefined;
        let regResult: Awaited<ReturnType<typeof auth.register>>;
        try {
          regResult = await auth.register(email, password, name, acceptTerms, attribution);
        } catch (err) {
          // Attribution must never cost a sign-up: should the backend refuse
          // it (a key it does not know yet), sign up without it.
          if (!attribution || !(err instanceof ApiError) || err.status !== 400 || !JSON.stringify(err.body).includes('attribution')) {
            throw err;
          }
          regResult = await auth.register(email, password, name, acceptTerms);
        }
        clearSignupAttribution();
        if (regResult.accessToken) {
          result = { accessToken: regResult.accessToken, user: regResult.user };
          needsLicenseSetup = !!regResult.isFirstUser;
        } else {
          // Cloud answers the same whether or not the address already has an
          // account. Signing in with what was just entered works only for the
          // account just created; otherwise the email says what to do.
          try {
            const loginResult = await auth.login(email, password);
            result = loginResult;
            needsLicenseSetup = !!loginResult.needsLicenseSetup;
            // A verified account can only be one that existed before this
            // sign-up: say so, rather than silently landing in a workspace
            // the person thought they were creating. Only someone who typed
            // the account's password sees this, so it reveals nothing.
            if (loginResult.user?.emailVerified) {
              toast.show({
                title: 'You already have an account',
                description: 'This address was already registered, so we signed you in to your existing workspace.',
                tone: 'info',
                durationMs: 9000,
              });
            }
          } catch {
            setUserEmail(email);
            setSetupStep('check-inbox');
            return;
          }
        }
      } else if (recoveryMode) {
        result = await recoveryApi.login(email, recoveryCode);
      } else {
        const loginResult = await auth.login(email, password);
        result = loginResult;
        needsLicenseSetup = !!loginResult.needsLicenseSetup;
      }

      // Check if email needs verification
      if (!result.user.emailVerified) {
        setAuthToken(result.accessToken);
        setStoredUser(result.user);
        setUserEmail(result.user.email);
        setIsFirstUserFlag(needsLicenseSetup);
        setResendCooldown(60);
        setSetupStep('verify-email');
      } else {
        login(result.accessToken, result.user);
        if (isCloudMode && needsLicenseSetup) {
          // Cloud mode: auto-activate trial for verified users
          setAuthToken(result.accessToken);
          try {
            const trialResult = await license.activateTrial(result.accessToken);
            if (offerCardTrial(result.user, trialResult)) return;
            // "Trial Activated!" only for a trial started just now. A workspace
            // that already holds a licence (a running trial, a paid plan) goes
            // straight in, instead of being told it has "0 days" left.
            if (!trialResult.trialStarted) {
              router.push(redirectTo);
              return;
            }
            setTrialDaysLeft(trialResult.trialDaysLeft);
            setSetupStep('trial-activated');
          } catch {
            router.push(redirectTo);
          }
        } else if (needsLicenseSetup) {
          setAuthToken(result.accessToken);
          setSetupStep('license-choice');
        } else {
          router.push(redirectTo);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    setError('');
    setResendMessage('');
    setLoading(true);
    try {
      await auth.verifyEmail(verificationCode, authToken);
      // The Google Ads conversion (cloud only; a no-op without GTM).
      pushSignUpVerified(String(storedUser?.id ?? 'code'), 'code');
      // Email verified — now log in and proceed
      const verifiedUser = { ...storedUser, emailVerified: true };
      login(authToken, verifiedUser);

      if (isCloudMode) {
        // Cloud mode: auto-activate trial
        try {
          const trialResult = await license.activateTrial(authToken);
          if (offerCardTrial(storedUser, trialResult)) return;
          setTrialDaysLeft(trialResult.trialDaysLeft);
          setSetupStep('trial-activated');
        } catch (trialErr: any) {
          // Trial may already exist (e.g. returning user) — go to dashboard
          router.push(redirectTo);
        }
      } else if (isFirstUserFlag) {
        setSetupStep('license-choice');
      } else {
        router.push(redirectTo);
      }
    } catch (err: any) {
      setError(err.message || 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleResendCode = useCallback(async () => {
    if (resendCooldown > 0) return;
    setError('');
    setResendMessage('');
    try {
      await auth.resendVerification(authToken);
      setResendMessage('A new code has been sent to your email');
      setResendCooldown(60);
    } catch (err: any) {
      setError(err.message || 'Failed to resend code');
    }
  }, [resendCooldown, authToken]);

  const handlePersonalUse = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await license.registerCommunity(authToken);
      setUserEmail(result.email);
      setSetupStep('license-email-sent');
    } catch (err: any) {
      setError(err.message || 'Failed to request license');
    } finally {
      setLoading(false);
    }
  };

  // A company starts on the Business trial right away: it runs on this
  // instance, with no payment details and nothing sent anywhere.
  const handleCompanyUse = async () => {
    setError('');
    setLoading(true);
    try {
      await license.startBusinessTrial(authToken);
      router.push(redirectTo);
    } catch (err: any) {
      setError(err.message || 'Could not start the trial');
      setLoading(false);
    }
  };

  const handleCommercialChoice = () => {
    setSetupStep('license-key');
  };

  const handleActivateLicense = async () => {
    setError('');
    setLoading(true);
    try {
      await license.setKey(licenseKey, authToken);
      router.push(redirectTo);
    } catch (err: any) {
      setError(err.message || 'Failed to activate license');
      setLoading(false);
    }
  };

  const handleSkip = () => {
    router.push(redirectTo);
  };

  // ── Email Verification Step ─────────────────────────────────────────────

  if (setupStep === 'verify-email') {
    return (
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">Verify Your Email</h1>
            <p className="text-[var(--text-2)] mt-1 text-sm">
              We sent a 6-digit code to <strong className="text-[var(--text)]">{userEmail}</strong>
            </p>
          </div>

          {error && <div className={alertDanger}>{error}</div>}

          {resendMessage && <div className={alertSuccess}>{resendMessage}</div>}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text)]">Verification Code</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full text-center text-2xl tracking-[0.5em] font-mono h-12 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--text)] placeholder:text-[var(--text-3)] outline-none transition-colors focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand-ring)]"
                autoFocus
              />
            </div>

            <Button
              onClick={handleVerifyCode}
              disabled={loading || verificationCode.length !== 6}
              className="w-full"
              size="lg"
            >
              {loading ? 'Verifying...' : 'Verify Email'}
            </Button>
          </div>

          <p className="text-center text-sm text-[var(--text-2)] mt-4">
            Didn&apos;t receive it?{' '}
            <button
              onClick={handleResendCode}
              disabled={resendCooldown > 0}
              className="text-[var(--brand)] hover:underline font-medium disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
            >
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
            </button>
          </p>

          {isFirstUserFlag && !isCloudMode && (
            <div className="text-center mt-3">
              <button
                onClick={() => {
                  login(authToken, storedUser);
                  setSetupStep('license-choice');
                }}
                className="text-sm text-[var(--text-2)] hover:text-[var(--brand)] hover:underline"
              >
                Skip for now
              </button>
            </div>
          )}
        </Card>
      </div>
    );
  }

  // ── Check Inbox Step (Cloud sign-up for an address we cannot sign in to) ──

  if (setupStep === 'check-inbox') {
    return (
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">Check your inbox</h1>
            <p className="text-[var(--text-2)] mt-1 text-sm">
              We sent an email to <strong className="text-[var(--text)]">{userEmail}</strong>.
            </p>
          </div>
          <p className="text-sm text-[var(--text-2)] mb-4">
            If this address already has an AnythingMCP account, the email has a link to sign in
            or reset your password. Otherwise, follow the link in it to verify the address.
          </p>
          <Button
            onClick={() => {
              setSetupStep('auth');
              setIsRegister(false);
              setPassword('');
              setConfirmPassword('');
            }}
            className="w-full"
            size="lg"
          >
            Back to sign in
          </Button>
          <p className="text-center text-sm text-[var(--text-2)] mt-4">
            <Link href="/forgot-password" className="text-[var(--brand)] hover:underline font-medium">
              Forgot your password?
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  // ── Trial Activated Step (Cloud Mode) ───────────────────────────────────

  if (setupStep === 'trial-activated') {
    return (
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">Trial Activated!</h1>
            <p className="text-[var(--text-2)] mt-1 text-sm">
              Your 7-day free trial is now active
            </p>
          </div>

          <div className="text-center mb-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--t-success-bg)] mb-3">
              <svg className="w-6 h-6 text-[var(--t-success-fg)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm text-[var(--text-2)]">
              You have <strong className="text-[var(--text)]">{trialDaysLeft} days</strong> to explore AnythingMCP Cloud.
            </p>
          </div>

          <div className="bg-[var(--surface-2)] rounded-[9px] p-4 mb-4">
            <p className="text-xs font-medium text-[var(--text-3)] mb-2">YOUR TRIAL INCLUDES</p>
            <ul className="space-y-1.5 text-sm text-[var(--text-2)]">
              <li className="flex items-center gap-2">
                <span className="text-[var(--ok)]">&#10003;</span> Up to 2 connectors
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[var(--ok)]">&#10003;</span> Up to 2 MCP servers
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[var(--ok)]">&#10003;</span> 1 user seat
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[var(--ok)]">&#10003;</span> Full audit log
              </li>
            </ul>
          </div>

          <Button onClick={() => router.push(redirectTo)} className="w-full" size="lg">
            Get Started
          </Button>
        </Card>
      </div>
    );
  }

  // ── License Choice Step ─────────────────────────────────────────────────

  if (setupStep === 'license-choice') {
    return (
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">Welcome to Anything<span className="text-[var(--brand)]">MCP</span></h1>
            <p className="text-[var(--text-2)] mt-1 text-sm">
              One last step to get started
            </p>
          </div>

          <h2 className="text-base font-semibold mb-2 text-center text-[var(--text)]">
            How will you use Anything<span className="text-[var(--brand)]">MCP</span>?
          </h2>
          <p className="text-sm text-[var(--text-2)] mb-6 text-center">
            You can change this later under Settings → License.
          </p>

          {error && <div className={alertDanger}>{error}</div>}

          <div className="space-y-3">
            <button
              onClick={handlePersonalUse}
              disabled={loading}
              className="w-full border border-[var(--border)] rounded-[9px] p-4 text-left hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors disabled:opacity-50"
            >
              <div className="font-medium text-sm text-[var(--text)]">Personal, education or evaluation</div>
              <div className="text-xs text-[var(--text-2)] mt-1">
                Community edition, free, for up to 3 users. We email you a
                community key so you get security and release notices.
              </div>
            </button>

            <button
              onClick={handleCompanyUse}
              disabled={loading}
              className="w-full border border-[var(--border)] rounded-[9px] p-4 text-left hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors disabled:opacity-50"
            >
              <div className="font-medium text-sm text-[var(--text)]">For a company or team</div>
              <div className="text-xs text-[var(--text-2)] mt-1">
                Try Business free for 30 days: more users, single sign-on with
                Entra ID, Google or Okta, and SCIM. No payment details.
              </div>
            </button>
          </div>

          <div className="mt-4 flex justify-between text-sm">
            <button
              onClick={handleCommercialChoice}
              className="text-[var(--text-2)] hover:text-[var(--brand)] hover:underline"
            >
              I have a license key
            </button>
            <button
              onClick={handleSkip}
              className="text-sm text-[var(--text-2)] hover:text-[var(--brand)] hover:underline"
            >
              Skip for now
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // ── License Email Sent Step ────────────────────────────────────────────

  if (setupStep === 'license-email-sent') {
    return (
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">Check Your Email</h1>
            <p className="text-[var(--text-2)] mt-1 text-sm">
              We sent your license key to <strong className="text-[var(--text)]">{userEmail}</strong>
            </p>
          </div>

          <p className="text-sm text-[var(--text-2)] mb-4">
            Enter the key from that email to record it on this instance. It is
            already fully usable either way.
          </p>

          {error && <div className={alertDanger}>{error}</div>}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text)]">License Key</label>
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                placeholder="AMCP-XXXX-XXXX-XXXX-XXXX"
                className={cn(inputClass, 'font-mono tracking-wider')}
              />
            </div>

            <Button
              onClick={handleActivateLicense}
              disabled={loading || !licenseKey}
              className="w-full"
              size="lg"
            >
              {loading ? 'Activating...' : 'Activate License'}
            </Button>
          </div>

          <div className="flex justify-between mt-4 text-sm">
            <p className="text-[var(--text-2)]">
              Didn&apos;t receive it? Check your spam folder.
            </p>
            <button
              onClick={handleSkip}
              className="text-[var(--text-2)] hover:text-[var(--brand)] hover:underline whitespace-nowrap ml-2"
            >
              Skip
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // ── License Key Entry Step ──────────────────────────────────────────────

  if (setupStep === 'license-key') {
    return (
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">Activate License</h1>
            <p className="text-[var(--text-2)] mt-1 text-sm">
              Enter your license key to activate Anything<span className="text-[var(--brand)]">MCP</span>
            </p>
          </div>

          <p className="text-sm text-[var(--text-2)] mb-4">
            Business and Enterprise license keys are available at{' '}
            <a
              href={buildPricingUrl(undefined, null, true)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--brand)] hover:underline font-medium"
            >
              anythingmcp.com
            </a>
            .
          </p>

          {error && <div className={alertDanger}>{error}</div>}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text)]">License Key</label>
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                placeholder="AMCP-XXXX-XXXX-XXXX-XXXX"
                className={cn(inputClass, 'font-mono tracking-wider')}
              />
            </div>

            <Button
              onClick={handleActivateLicense}
              disabled={loading || !licenseKey}
              className="w-full"
              size="lg"
            >
              {loading ? 'Activating...' : 'Activate License'}
            </Button>
          </div>

          <div className="flex justify-between mt-4 text-sm">
            <button
              onClick={() => setSetupStep('license-choice')}
              className="text-[var(--text-2)] hover:text-[var(--brand)] hover:underline"
            >
              Back
            </button>
            <button
              onClick={handleSkip}
              className="text-[var(--text-2)] hover:text-[var(--brand)] hover:underline"
            >
              Skip for now
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // ── Auth Form (Login / Register) ──────────────────────────────────────────

  return (
    <div className="w-full max-w-sm">
      <Card className="p-6">
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <BrandMark />
          </div>
          <h1 className="text-xl font-semibold text-[var(--text)]">
            {isRegister ? 'Create your account' : 'Sign in'}
          </h1>
          <p className="text-[var(--text-2)] mt-1 text-sm">
            Create custom connectors for Claude, ChatGPT, Copilot and any AI agent
          </p>
        </div>

        {emailVerifiedParam === 'true' && (
          <div className={alertSuccess}>
            Email verified successfully! You can now sign in.
          </div>
        )}

        {error && <div className={alertDanger}>{error}</div>}

        {ssoExchanging && (
          <p className="text-center text-sm text-[var(--text-2)] py-6">
            Signing you in…
          </p>
        )}

        {!ssoExchanging && !isRegister && ssoProviders.length > 0 && (
          <div className="space-y-2 mb-4">
            {ssoProviders.map((p) => (
              <a
                key={p.startUrl}
                href={p.startUrl}
                className="flex items-center justify-center gap-2.5 w-full h-10 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-sm font-medium text-[var(--text)] hover:border-[var(--brand)] transition-colors"
              >
                <ProviderMark type={p.type} />
                <span>{p.name}</span>
              </a>
            ))}
            <div className="flex items-center gap-3 pt-1">
              <div className="h-px flex-1 bg-[var(--border)]" />
              <span className="text-[11.5px] text-[var(--text-3)]">or</span>
              <div className="h-px flex-1 bg-[var(--border)]" />
            </div>
          </div>
        )}

        <form
          className={`space-y-4${ssoExchanging ? ' hidden' : ''}`}
          onSubmit={handleSubmit}
        >
          {isRegister && (
            <div>
              <label htmlFor="auth-name" className="block text-sm font-medium mb-1 text-[var(--text)]">Name</label>
              <input
                id="auth-name"
                name="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className={inputClass}
                required
              />
            </div>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-sm font-medium mb-1 text-[var(--text)]">Email</label>
            <input
              id="auth-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              className={inputClass}
              required
            />
          </div>

          <div className={recoveryMode ? 'hidden' : undefined}>
            <label htmlFor="auth-password" className="block text-sm font-medium mb-1 text-[var(--text)]">Password</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              className={inputClass}
              // A hidden field that is still `required` blocks submission with
              // a validation bubble the user cannot see or reach.
              required={!recoveryMode}
              minLength={8}
            />
            {isRegister && password.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-xs">
                {[
                  [password.length >= 8, 'At least 8 characters'],
                  [/[A-Z]/.test(password), 'One uppercase letter'],
                  [/[a-z]/.test(password), 'One lowercase letter'],
                  [/\d/.test(password), 'One number'],
                  [/[^a-zA-Z0-9]/.test(password), 'One special character'],
                ].map(([ok, label]) => (
                  <li key={label as string} className={ok ? 'text-[var(--ok)]' : 'text-[var(--text-3)]'}>
                    {ok ? '\u2713' : '\u2022'} {label as string}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {isRegister && (
            <>
              <div>
                <label htmlFor="auth-confirm-password" className="block text-sm font-medium mb-1 text-[var(--text)]">Confirm Password</label>
                <input
                  id="auth-confirm-password"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat your password"
                  className={inputClass}
                  required
                  minLength={8}
                />
              </div>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                  className="mt-0.5 accent-[var(--brand)]"
                />
                <span className="text-sm text-[var(--text-2)]">
                  I accept the{' '}
                  <a
                    href="https://anythingmcp.com/en/agb"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--brand)] hover:underline font-medium"
                  >
                    Terms of Use
                  </a>
                </span>
              </label>
            </>
          )}

          {recoveryMode && (
            <div>
              <label htmlFor="auth-recovery-code" className="block text-sm font-medium mb-1 text-[var(--text)]">
                Recovery code
              </label>
              <input
                id="auth-recovery-code"
                name="recovery-code"
                type="text"
                autoComplete="one-time-code"
                spellCheck={false}
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="XXXXX-XXXXX"
                className={`${inputClass} tracking-widest uppercase`}
                required
              />
              <p className="text-xs text-[var(--text-2)] mt-1.5">
                One of the codes you saved when setting up single sign-on. Each works once.
              </p>
            </div>
          )}

          <Button type="submit" disabled={loading} className="w-full" size="lg">
            {loading
              ? 'Loading...'
              : isRegister
                ? 'Create Account'
                : recoveryMode
                  ? 'Sign in with recovery code'
                  : 'Sign In'}
          </Button>
        </form>

        {!isRegister && (
          <p className="text-center text-sm mt-3 flex items-center justify-center gap-3">
            {!recoveryMode && (
              <Link href="/forgot-password" className="text-[var(--text-2)] hover:text-[var(--brand)] hover:underline">
                Forgot password?
              </Link>
            )}
            {/*
              Always reachable, not just once a password has been refused: the
              situation this exists for is one where the identity provider is
              down, and an admin should not have to guess a wrong password
              first to be offered the way in.
            */}
            <button
              type="button"
              onClick={() => { setRecoveryMode(!recoveryMode); setError(''); }}
              className="text-[var(--text-2)] hover:text-[var(--brand)] hover:underline"
            >
              {recoveryMode ? 'Back to password sign-in' : 'Use a recovery code'}
            </button>
          </p>
        )}

        {(registrationEnabled || isRegister) && (
          <p className="text-center text-sm text-[var(--text-2)] mt-3">
            {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              onClick={() => { setIsRegister(!isRegister); setError(''); }}
              className="text-[var(--brand)] hover:underline font-medium"
            >
              {isRegister ? 'Sign In' : 'Register'}
            </button>
          </p>
        )}
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    // <main>, not a <div>: this page sits outside AppShell, so without it the
    // document has no main landmark for a screen reader to jump to.
    <main className="min-h-dvh flex items-center justify-center bg-[var(--bg)] px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
