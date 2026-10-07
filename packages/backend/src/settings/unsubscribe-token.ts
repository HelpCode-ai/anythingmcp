import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed one-click unsubscribe links for marketing email (RFC 8058). The link
 * carries the user id and an HMAC of it, so it works without signing in and
 * cannot be forged for anyone else. Keyed on a value derived from JWT_SECRET,
 * so it never equals any other token the backend issues.
 */
function key(secret: string): Buffer {
  return createHmac('sha256', secret).update('amcp-unsubscribe-v1').digest();
}

export function unsubscribeSecret(): string | null {
  return process.env.JWT_SECRET || null;
}

export function signUnsubscribe(userId: string, secret: string): string {
  return createHmac('sha256', key(secret)).update(userId).digest('base64url');
}

export function verifyUnsubscribe(userId: unknown, token: unknown, secret: string): boolean {
  if (typeof userId !== 'string' || typeof token !== 'string' || !userId || !token) return false;
  const expected = Buffer.from(signUnsubscribe(userId, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** `${baseUrl}/api/public/unsubscribe?u=…&t=…` — served through the dashboard origin. */
export function buildUnsubscribeUrl(baseUrl: string, userId: string, secret: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/api/public/unsubscribe?u=${encodeURIComponent(userId)}&t=${signUnsubscribe(userId, secret)}`;
}
