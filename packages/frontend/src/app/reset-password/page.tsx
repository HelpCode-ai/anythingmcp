'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/api';
import { LogoIcon } from '@/components/nav-bar';

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
        <h2 className="text-lg font-semibold mb-2">Invalid Link</h2>
        <p className="text-sm text-[var(--muted-foreground)] mb-4">
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
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[var(--success-bg)] flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--success-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      </div>
      <h2 className="text-lg font-semibold mb-2">Password Reset</h2>
      <p className="text-sm text-[var(--muted-foreground)] mb-4">
        Your password has been reset successfully.
      </p>
      <Link
        href="/login"
        className="inline-block bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:brightness-90"
      >
        Sign In
      </Link>
    </div>
  ) : (
    <>
      <h2 className="text-lg font-semibold mb-2 text-center">Reset Password</h2>
      <p className="text-sm text-[var(--muted-foreground)] mb-4 text-center">
        Enter your new password below.
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-[var(--destructive-bg)] text-[var(--destructive-text)] text-sm border border-[var(--destructive-border)]">
          {error}
        </div>
      )}

      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="block text-sm font-medium mb-1">New Password</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Min. 8 characters"
            className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Confirm Password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat password"
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
          {loading ? 'Resetting...' : 'Reset Password'}
        </button>
      </form>

      <p className="text-center text-sm text-[var(--muted-foreground)] mt-4">
        <Link href="/login" className="text-[var(--brand)] hover:underline font-medium">
          Back to Sign In
        </Link>
      </p>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <LogoIcon size={56} />
          </div>
          <h1 className="text-2xl font-bold">AnythingToMCP</h1>
        </div>

        <div className="border border-[var(--border)] rounded-lg p-6 bg-[var(--card)]">
          <Suspense>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
