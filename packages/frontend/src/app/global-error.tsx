'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { isNetworkError, reloadWhenOnline } from '@/lib/network-error';

/**
 * Last-resort boundary: renders when the root layout itself throws, where
 * error.tsx cannot help. It replaces the whole document, so it carries its
 * own <html> and inline styles and depends on nothing else in the app.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  const offline = isNetworkError(error);

  useEffect(() => {
    // A dropped connection is not a bug in the page: keep counting it, as a
    // warning, and reload by ourselves once the network is back.
    Sentry.captureException(error, {
      level: offline ? 'warning' : 'error',
      tags: { boundary: 'global', network: offline ? 'yes' : 'no' },
    });
    return offline ? reloadWhenOnline() : undefined;
  }, [error, offline]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          padding: 24,
        }}
      >
        <div role="alert" style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>
            {offline ? 'Connection lost' : 'Something went wrong'}
          </h1>
          <p style={{ color: '#6b7280', marginBottom: 16 }}>
            {offline
              ? 'AnythingMCP could not reach the server. The page reloads by itself when your connection is back.'
              : 'AnythingMCP could not load this page. Reload to try again.'}
          </p>
          {error?.digest ? (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              Error reference: <strong>{error.digest}</strong>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
