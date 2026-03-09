'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { auth, license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/nav-bar';

type SetupStep = 'auth' | 'verify-email' | 'license-choice' | 'license-email-sent' | 'license-key';

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();

  const redirectTo = searchParams.get('redirect') || '/';
  const emailVerifiedParam = searchParams.get('emailVerified');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let isFirstUser = false;
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
        isFirstUser = !!regResult.isFirstUser;
      } else {
        result = await auth.login(email, password);
      }

      // Check if email needs verification
      if (!result.user.emailVerified) {
        setAuthToken(result.accessToken);
        setStoredUser(result.user);
        setUserEmail(result.user.email);
        setIsFirstUserFlag(isFirstUser);
        setResendCooldown(60);
        setSetupStep('verify-email');
      } else {
        login(result.accessToken, result.user);
        if (isFirstUser) {
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
      if (isFirstUserFlag) {
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
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <LogoIcon size={56} />
          </div>
          <h1 className="text-2xl font-bold">Verify Your Email</h1>
          <p className="text-[var(--muted-foreground)] mt-1 text-sm">
            We sent a 6-digit code to <strong>{userEmail}</strong>
          </p>
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
          {error && (
            <div className="mb-4 p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
              {error}
            </div>
          )}

          {resendMessage && (
            <div className="mb-4 p-3 rounded-md bg-green-50 text-green-800 text-sm border border-green-200 dark:bg-green-950 dark:text-green-200 dark:border-green-800">
              {resendMessage}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Verification Code</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full text-center text-2xl tracking-[0.5em] font-mono border border-[var(--input)] rounded-md px-3 py-3 bg-[var(--background)]"
                autoFocus
              />
            </div>

            <button
              onClick={handleVerifyCode}
              disabled={loading || verificationCode.length !== 6}
              className="w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Verify Email'}
            </button>
          </div>

          <p className="text-center text-sm text-[var(--muted-foreground)] mt-4">
            Didn&apos;t receive it?{' '}
            <button
              onClick={handleResendCode}
              disabled={resendCooldown > 0}
              className="text-[var(--brand)] hover:underline font-medium disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
            >
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
            </button>
          </p>
        </div>
      </div>
    );
  }

  // ── License Choice Step ─────────────────────────────────────────────────

  if (setupStep === 'license-choice') {
    return (
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <LogoIcon size={56} />
          </div>
          <h1 className="text-2xl font-bold">Welcome to AnythingMCP</h1>
          <p className="text-[var(--muted-foreground)] mt-1 text-sm">
            One last step to get started
          </p>
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
          <h2 className="text-lg font-semibold mb-2 text-center">
            How will you use AnythingMCP?
          </h2>
          <p className="text-sm text-[var(--muted-foreground)] mb-6 text-center">
            Commercial use requires a license from anythingmcp.com
          </p>

          <div className="space-y-3">
            <button
              onClick={handlePersonalUse}
              disabled={loading}
              className="w-full border border-[var(--border)] rounded-lg p-4 text-left hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors disabled:opacity-50"
            >
              <div className="font-medium text-sm">Personal / Non-commercial</div>
              <div className="text-xs text-[var(--muted-foreground)] mt-1">
                Free community license — unlimited connectors and users
              </div>
            </button>

            <button
              onClick={handleCommercialChoice}
              disabled={loading}
              className="w-full border border-[var(--border)] rounded-lg p-4 text-left hover:border-[var(--brand)] hover:bg-[var(--brand-light)] transition-colors disabled:opacity-50"
            >
              <div className="font-medium text-sm">Commercial</div>
              <div className="text-xs text-[var(--muted-foreground)] mt-1">
                For businesses — purchase a license to unlock all features
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── License Email Sent Step ────────────────────────────────────────────

  if (setupStep === 'license-email-sent') {
    return (
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <LogoIcon size={56} />
          </div>
          <h1 className="text-2xl font-bold">Check Your Email</h1>
          <p className="text-[var(--muted-foreground)] mt-1 text-sm">
            We sent your license key to <strong>{userEmail}</strong>
          </p>
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
          <p className="text-sm text-[var(--muted-foreground)] mb-4">
            Enter the license key from the email to activate your instance.
          </p>

          {error && (
            <div className="mb-4 p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">License Key</label>
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                placeholder="AMCP-XXXX-XXXX-XXXX-XXXX"
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono tracking-wider"
              />
            </div>

            <button
              onClick={handleActivateLicense}
              disabled={loading || !licenseKey}
              className="w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
            >
              {loading ? 'Activating...' : 'Activate License'}
            </button>
          </div>

          <div className="flex justify-between mt-4 text-sm">
            <p className="text-[var(--muted-foreground)]">
              Didn&apos;t receive it? Check your spam folder.
            </p>
            <button
              onClick={handleSkip}
              className="text-[var(--muted-foreground)] hover:text-[var(--brand)] hover:underline whitespace-nowrap ml-2"
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── License Key Entry Step ──────────────────────────────────────────────

  if (setupStep === 'license-key') {
    return (
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <LogoIcon size={56} />
          </div>
          <h1 className="text-2xl font-bold">Activate License</h1>
          <p className="text-[var(--muted-foreground)] mt-1 text-sm">
            Enter your license key to activate AnythingMCP
          </p>
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
          <p className="text-sm text-[var(--muted-foreground)] mb-4">
            Purchase a license at{' '}
            <a
              href="https://anythingmcp.com/pricing"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--brand)] hover:underline font-medium"
            >
              anythingmcp.com
            </a>
            , then enter your key below.
          </p>

          {error && (
            <div className="mb-4 p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">License Key</label>
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
                placeholder="AMCP-XXXX-XXXX-XXXX-XXXX"
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] font-mono tracking-wider"
              />
            </div>

            <button
              onClick={handleActivateLicense}
              disabled={loading || !licenseKey}
              className="w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
            >
              {loading ? 'Activating...' : 'Activate License'}
            </button>
          </div>

          <div className="flex justify-between mt-4 text-sm">
            <button
              onClick={() => setSetupStep('license-choice')}
              className="text-[var(--muted-foreground)] hover:text-[var(--brand)] hover:underline"
            >
              Back
            </button>
            <button
              onClick={handleSkip}
              className="text-[var(--muted-foreground)] hover:text-[var(--brand)] hover:underline"
            >
              Skip for now
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Auth Form (Login / Register) ──────────────────────────────────────────

  return (
    <div className="w-full max-w-sm">
      <div className="text-center mb-8">
        <div className="flex justify-center mb-4">
          <LogoIcon size={56} />
        </div>
        <h1 className="text-2xl font-bold">AnythingMCP</h1>
        <p className="text-[var(--muted-foreground)] mt-1 text-sm">
          Convert any API into an MCP server
        </p>
      </div>

      <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
        <h2 className="text-lg font-semibold mb-4 text-center">
          {isRegister ? 'Create your account' : 'Sign in'}
        </h2>

        {emailVerifiedParam === 'true' && (
          <div className="mb-4 p-3 rounded-md bg-green-50 text-green-800 text-sm border border-green-200 dark:bg-green-950 dark:text-green-200 dark:border-green-800">
            Email verified successfully! You can now sign in.
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
            {error}
          </div>
        )}

        <form className="space-y-4" onSubmit={handleSubmit}>
          {isRegister && (
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                required
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
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
                  <li key={label as string} className={ok ? 'text-green-500' : 'text-[var(--muted-foreground)]'}>
                    {ok ? '\u2713' : '\u2022'} {label as string}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {isRegister && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat your password"
                  className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
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
                <span className="text-sm text-[var(--muted-foreground)]">
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

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
          >
            {loading ? 'Loading...' : isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        {!isRegister && (
          <p className="text-center text-sm mt-3">
            <Link href="/forgot-password" className="text-[var(--muted-foreground)] hover:text-[var(--brand)] hover:underline">
              Forgot password?
            </Link>
          </p>
        )}

        <p className="text-center text-sm text-[var(--muted-foreground)] mt-3">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            onClick={() => { setIsRegister(!isRegister); setError(''); }}
            className="text-[var(--brand)] hover:underline font-medium"
          >
            {isRegister ? 'Sign In' : 'Register'}
          </button>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
