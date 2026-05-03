'use client';

import { useEffect } from 'react';

/**
 * Global error boundary. Renders for any uncaught exception inside an App
 * Router segment that hasn't installed its own error.tsx.
 *
 * Without this, Next.js falls back to its built-in dev / "Application
 * error" screen — fine in development but a poor first impression in
 * production. We surface a calm message + a retry button + the digest
 * Next assigns to the error so a user can quote it when reporting a bug.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Avoid leaking stack traces; just record that something tripped.
    if (typeof window !== 'undefined' && error?.digest) {
      console.error(`[error.tsx] uncaught error (digest=${error.digest})`);
    } else {
      console.error('[error.tsx] uncaught error', error);
    }
  }, [error]);

  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        role="alert"
        style={{
          maxWidth: 480,
          width: '100%',
          background: 'var(--card, #fff)',
          color: 'var(--foreground, #111827)',
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 12,
          padding: 24,
          boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
          Something went wrong
        </h1>
        <p style={{ color: 'var(--muted-foreground, #6b7280)', marginBottom: 16 }}>
          The page hit an unexpected error. You can retry, or go back to the
          dashboard.
        </p>

        {error?.digest ? (
          <p
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 12,
              color: 'var(--muted-foreground, #6b7280)',
              marginBottom: 16,
            }}
          >
            Error reference: <strong>{error.digest}</strong>
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--brand, #2563eb)',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Try again
          </button>
          <a
            href="/"
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid var(--border, #e5e7eb)',
              color: 'inherit',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            Go to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
