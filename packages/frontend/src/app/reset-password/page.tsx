'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { LogoIcon } from '@/components/logo-icon';
import { Card } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (!token) {
      setError('Invalid reset link');
      return;
    }

    setLoading(true);
    try {
      await auth.resetPassword(token, newPassword);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="text-center">
        <h2 className="text-base font-semibold mb-2 text-[var(--text)]">Invalid Link</h2>
        <p className="text-sm text-[var(--text-2)] mb-4">
          This password reset link is invalid or has expired.
        </p>
        <Link href="/forgot-password" className="text-[var(--brand)] hover:underline text-sm font-medium">
          Request a new link
        </Link>
      </div>
    );
  }

  return success ? (
    <div className="text-center">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[var(--t-success-bg)] flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--t-success-fg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <h2 className="text-base font-semibold mb-2 text-[var(--text)]">Password Reset</h2>
      <p className="text-sm text-[var(--text-2)] mb-4">
        Your password has been reset successfully.
      </p>
      <Link
        href="/login"
        className={cn(buttonVariants({ variant: 'primary', size: 'lg' }))}
      >
        Sign In
      </Link>
    </div>
  ) : (
    <>
      <h2 className="text-base font-semibold mb-2 text-center text-[var(--text)]">Reset Password</h2>
      <p className="text-sm text-[var(--text-2)] mb-4 text-center">
        Enter your new password below.
      </p>

      {error && (
        <div className="mb-4 rounded-[9px] px-3 py-2.5 text-sm bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]">
          {error}
        </div>
      )}

      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="reset-new-password" className="block text-sm font-medium mb-1 text-[var(--text)]">New Password</label>
          <input
            id="reset-new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Min. 8 characters"
            className={inputClass}
            required
            minLength={8}
          />
        </div>
        <div>
          <label htmlFor="reset-confirm-password" className="block text-sm font-medium mb-1 text-[var(--text)]">Confirm Password</label>
          <input
            id="reset-confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat password"
            className={inputClass}
            required
            minLength={8}
          />
        </div>
        <Button type="submit" disabled={loading} className="w-full" size="lg">
          {loading ? 'Resetting...' : 'Reset Password'}
        </Button>
      </form>

      <p className="text-center text-sm text-[var(--text-2)] mt-4">
        <Link href="/login" className="text-[var(--brand)] hover:underline font-medium">
          Back to Sign In
        </Link>
      </p>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm">
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center">
              <BrandMark />
            </div>
          </div>

          <Suspense>
            <ResetPasswordForm />
          </Suspense>
        </Card>
      </div>
    </div>
  );
}
