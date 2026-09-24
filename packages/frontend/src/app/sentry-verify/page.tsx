import { createHash, timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ClientTrigger } from './client-trigger';

/**
 * Deliberate errors for an operator to confirm, end to end, that frontend
 * errors reach Sentry with readable stack traces and without query strings,
 * fragments or request data.
 *
 * 404 unless SENTRY_VERIFY_TOKEN is set on the frontend container. With it:
 * - a request carrying the token in `x-sentry-verify` throws on the server;
 * - a browser opening /sentry-verify#<token> throws on the client (the page
 *   receives only the token's SHA-256, never the token).
 * Unset the variable once the check is done.
 */
export default async function SentryVerifyPage() {
  const token = process.env.SENTRY_VERIFY_TOKEN;
  if (!token) notFound();

  const presented = (await headers()).get('x-sentry-verify');
  if (presented && sameSecret(presented, token)) {
    throw new Error('Sentry verification (frontend server)');
  }
  return <ClientTrigger tokenSha256={createHash('sha256').update(token).digest('hex')} />;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
