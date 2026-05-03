'use client';

import { useState } from 'react';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { LogoIcon } from '@/components/nav-bar';
import { useToast } from '@/components/toast';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await auth.forgotPassword(email);
      setSent(true);
      toast.show({
        tone: 'success',
        title: 'Reset link requested',
        description: 'If that email is registered, a reset link is on the way.',
      });
    } catch (err: any) {
      const message = err.message || 'Something went wrong';
      setError(message);
      toast.show({ tone: 'error', title: 'Request failed', description: message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <LogoIcon size={56} />
          </div>
          <h1 className="text-2xl font-bold">Anything<span className="text-[var(--brand)]">MCP</span></h1>
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
          {sent ? (
            <div className="text-center">
              <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[var(--success-bg)] flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--success-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold mb-2">Check your email</h2>
              <p className="text-sm text-[var(--muted-foreground)] mb-4">
                If an account with that email exists, we&apos;ve sent a password reset link.
              </p>
              <Link
                href="/login"
                className="text-[var(--brand)] hover:underline text-sm font-medium"
              >
                Back to Sign In
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-2 text-center">Forgot Password</h2>
              <p className="text-sm text-[var(--muted-foreground)] mb-4 text-center">
                Enter your email address and we&apos;ll send you a link to reset your password.
              </p>

              {error && (
                <div className="mb-4 p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
                  {error}
                </div>
              )}

              <form className="space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label htmlFor="forgot-email" className="block text-sm font-medium mb-1">Email</label>
                  <input
                    id="forgot-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@example.com"
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-[var(--brand)] text-white px-4 py-2.5 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
                >
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>

              <p className="text-center text-sm text-[var(--muted-foreground)] mt-4">
                <Link href="/login" className="text-[var(--brand)] hover:underline font-medium">
                  Back to Sign In
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
