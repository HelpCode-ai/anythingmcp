'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { auth, license } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/nav-bar';

type SetupStep = 'auth' | 'license-choice' | 'license-key';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState('');
  const [setupStep, setSetupStep] = useState<SetupStep>('auth');
  const [licenseKey, setLicenseKey] = useState('');
  const [authToken, setAuthToken] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();

  const redirectTo = searchParams.get('redirect') || '/';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let isFirstUser = false;
      let result;
      if (isRegister) {
        const regResult = await auth.register(email, password, name);
        result = regResult;
        isFirstUser = !!regResult.isFirstUser;
      } else {
        result = await auth.login(email, password);
      }
      login(result.accessToken, result.user);

      // If this is the first user (admin), show license setup
      if (isFirstUser) {
        setAuthToken(result.accessToken);
        setSetupStep('license-choice');
      } else {
        router.push(redirectTo);
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handlePersonalUse = () => {
    // Fire-and-forget: register community license in background, navigate immediately
    license.registerCommunity(authToken).catch(() => {});
    router.push(redirectTo);
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
          </div>

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
