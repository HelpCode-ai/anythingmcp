'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { auth } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

function AcceptInviteContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { login } = useAuth();
  const token = searchParams.get('token') || '';

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [valid, setValid] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('No invitation token provided');
      setValid(false);
      return;
    }
    auth
      .verifyInvite(token)
      .then((data) => {
        setEmail(data.email);
        setRole(data.role);
        setValid(true);
      })
      .catch((err) => {
        setError(err.message);
        setValid(false);
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await auth.acceptInvite({ token, password, name });
      login(result.accessToken, result.user);
      router.push('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold">Accept Invitation</h1>
        <p className="text-[var(--muted-foreground)] text-sm mt-1">
          Create your AnythingToMCP account
        </p>
      </div>

      {valid === null && (
        <p className="text-center text-[var(--muted-foreground)]">Verifying invitation...</p>
      )}

      {valid === false && (
        <div className="border border-[var(--destructive-border)] bg-[var(--destructive-bg)] rounded-lg p-6 text-center">
          <h2 className="font-medium text-[var(--destructive)] mb-2">Invalid Invitation</h2>
          <p className="text-sm text-[var(--destructive-text)]">{error}</p>
          <a href="/login" className="text-sm text-[var(--brand)] hover:underline mt-4 inline-block">
            Go to Login
          </a>
        </div>
      )}

      {valid === true && (
        <form onSubmit={handleSubmit} className="border border-[var(--border)] rounded-lg p-6 space-y-4">
          <div className="border border-[var(--info-border)] bg-[var(--info-bg)] rounded-md p-3">
            <p className="text-sm text-[var(--info-text)]">
              You've been invited as <strong>{role}</strong> for <strong>{email}</strong>
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Your Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
              placeholder="Full name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              disabled
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--muted)] opacity-70"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              placeholder="Min. 8 characters"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              placeholder="Repeat password"
              className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
            />
          </div>

          {error && (
            <p className="text-sm text-[var(--destructive)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || !name || !password || password.length < 8}
            className="w-full bg-[var(--brand)] text-white py-2 rounded-md text-sm font-medium hover:brightness-90 disabled:opacity-50"
          >
            {submitting ? 'Creating account...' : 'Create Account'}
          </button>
        </form>
      )}
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center px-4">
      <Suspense fallback={<p className="text-[var(--muted-foreground)]">Loading...</p>}>
        <AcceptInviteContent />
      </Suspense>
    </div>
  );
}
