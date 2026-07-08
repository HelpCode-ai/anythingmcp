'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { auth, license, server } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { buildPricingUrl } from '@/lib/marketing';
import { LogoIcon } from '@/components/logo-icon';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type SetupStep = 'auth' | 'verify-email' | 'license-choice' | 'license-email-sent' | 'license-key' | 'trial-activated';

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

  const redirectTo = searchParams.get('redirect') || '/';
  const emailVerifiedParam = searchParams.get('emailVerified');
  const modeParam = searchParams.get('mode'); // 'register' or 'login'

  useEffect(() => {
    server.info().then((info) => {
      setRegistrationEnabled(info.registrationEnabled);
      setIsCloudMode(info.deploymentMode === 'cloud');
      if (!info.hasUsers) {
        setIsRegister(true);
      } else if (modeParam === 'register' && info.registrationEnabled) {
        setIsRegister(true);
      } else if (modeParam === 'login') {
        setIsRegister(false);
      }
    }).catch(() => {});
  }, [modeParam]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let needsLicenseSetup = false;
      let result;
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
        const regResult = await auth.register(email, password, name, acceptTerms);
        result = regResult;
        needsLicenseSetup = !!regResult.isFirstUser;
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
      // Email verified — now log in and proceed
      const verifiedUser = { ...storedUser, emailVerified: true };
      login(authToken, verifiedUser);

      if (isCloudMode) {
        // Cloud mode: auto-activate trial
        try {
          const trialResult = await license.activateTrial(authToken);
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
            Commercial use requires a license from anythingmcp.com
          </p>

          {error && <div className={alertDanger}>{error}</div>}

          <div className="space-y-3">
            <button
              onClick={handlePersonalUse}
              disabled={loading}
              className="w-full border border-[var(--border)] rounded-[9px] p-4 text-left hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors disabled:opacity-50"
            >
              <div className="font-medium text-sm text-[var(--text)]">Personal / Non-commercial</div>
              <div className="text-xs text-[var(--text-2)] mt-1">
                Free community license — unlimited connectors and users
              </div>
            </button>

            <button
              onClick={handleCommercialChoice}
              disabled={loading}
              className="w-full border border-[var(--border)] rounded-[9px] p-4 text-left hover:border-[var(--brand)] hover:bg-[var(--brand-tint)] transition-colors disabled:opacity-50"
            >
              <div className="font-medium text-sm text-[var(--text)]">Commercial</div>
              <div className="text-xs text-[var(--text-2)] mt-1">
                For businesses — purchase a license to unlock all features
              </div>
            </button>
          </div>

          {error && (
            <div className="mt-4 text-center">
              <button
                onClick={handleSkip}
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
            Enter the license key from the email to activate your instance.
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
            Purchase a license at{' '}
            <a
              href={buildPricingUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--brand)] hover:underline font-medium"
            >
              anythingmcp.com
            </a>
            , then enter your key below.
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

        <form className="space-y-4" onSubmit={handleSubmit}>
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

          <div>
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
              required
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

          <Button type="submit" disabled={loading} className="w-full" size="lg">
            {loading ? 'Loading...' : isRegister ? 'Create Account' : 'Sign In'}
          </Button>
        </form>

        {!isRegister && (
          <p className="text-center text-sm mt-3">
            <Link href="/forgot-password" className="text-[var(--text-2)] hover:text-[var(--brand)] hover:underline">
              Forgot password?
            </Link>
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
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
