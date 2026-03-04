'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { auth } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/nav-bar';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let result;
      if (isRegister) {
        result = await auth.register(email, password, name);
      } else {
        result = await auth.login(email, password);
      }
      login(result.accessToken, result.user);
      const redirectTo = searchParams.get('redirect') || '/';
      router.push(redirectTo);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

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
