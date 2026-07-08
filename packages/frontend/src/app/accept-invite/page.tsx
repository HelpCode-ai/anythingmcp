'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { auth } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/logo-icon';
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

const inputClass =
  'w-full h-10 rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] ' +
  'placeholder:text-[var(--text-3)] outline-none transition-colors ' +
  'focus:border-[var(--brand)] focus:ring-2 focus:ring-[var(--brand-ring)]';

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
      {valid === false ? (
        <Card className="p-6 text-center">
          <div className="flex justify-center mb-4">
            <BrandMark />
          </div>
          <div className="rounded-[9px] px-3 py-3 bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]">
            <h2 className="font-semibold mb-1">Invalid Invitation</h2>
            <p className="text-sm">{error}</p>
          </div>
          <a href="/login" className="text-sm text-[var(--brand)] hover:underline mt-4 inline-block">
            Go to Login
          </a>
        </Card>
      ) : (
        <Card className="p-6">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <BrandMark />
            </div>
            <h1 className="text-xl font-semibold text-[var(--text)]">Accept Invitation</h1>
            <p className="text-[var(--text-2)] text-sm mt-1">
              Create your Anything<span className="text-[var(--brand)]">MCP</span> account
            </p>
          </div>

          {valid === null && (
            <p className="text-center text-[var(--text-2)]">Verifying invitation...</p>
          )}

          {valid === true && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="rounded-[9px] px-3 py-2.5 bg-[var(--t-info-bg)] text-[var(--t-info-fg)]">
                <p className="text-sm">
                  You've been invited as <strong>{role}</strong> for <strong>{email}</strong>
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text)]">Your Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className={inputClass}
                  placeholder="Full name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text)]">Email</label>
                <input
                  type="email"
                  value={email}
                  disabled
                  className="w-full h-10 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-sm text-[var(--text)] opacity-70"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text)]">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="Min. 8 characters"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 text-[var(--text)]">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="Repeat password"
                  className={inputClass}
                />
              </div>

              {error && (
                <p className="text-sm text-[var(--danger)]">{error}</p>
              )}

              <Button
                type="submit"
                disabled={submitting || !name || !password || password.length < 8}
                className="w-full"
                size="lg"
              >
                {submitting ? 'Creating account...' : 'Create Account'}
              </Button>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center px-4">
      <Suspense fallback={<p className="text-[var(--text-2)]">Loading...</p>}>
        <AcceptInviteContent />
      </Suspense>
    </div>
  );
}
