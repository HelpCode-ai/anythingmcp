'use client';

import { useState } from 'react';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { LogoIcon } from '@/components/logo-icon';
import { useToast } from '@/components/toast';
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
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center">
              <BrandMark />
            </div>
          </div>

          {sent ? (
            <div className="text-center">
              <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[var(--t-success-bg)] flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--t-success-fg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              </div>
              <h2 className="text-base font-semibold mb-2 text-[var(--text)]">Check your email</h2>
              <p className="text-sm text-[var(--text-2)] mb-4">
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
              <h2 className="text-base font-semibold mb-2 text-center text-[var(--text)]">Forgot Password</h2>
              <p className="text-sm text-[var(--text-2)] mb-4 text-center">
                Enter your email address and we&apos;ll send you a link to reset your password.
              </p>

              {error && (
                <div className="mb-4 rounded-[9px] px-3 py-2.5 text-sm bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]">
                  {error}
                </div>
              )}

              <form className="space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label htmlFor="forgot-email" className="block text-sm font-medium mb-1 text-[var(--text)]">Email</label>
                  <input
                    id="forgot-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@example.com"
                    className="w-full h-10 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] placeholder:text-[var(--text-3)] outline-none transition-colors focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand-ring)]"
                    required
                  />
                </div>
                <Button type="submit" disabled={loading} className="w-full" size="lg">
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </Button>
              </form>

              <p className="text-center text-sm text-[var(--text-2)] mt-4">
                <Link href="/login" className="text-[var(--brand)] hover:underline font-medium">
                  Back to Sign In
                </Link>
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
