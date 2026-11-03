import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Stripe's `Stripe-Signature` scheme: `t=<unix seconds>,v1=<hex HMAC-SHA256
 * of "<t>.<raw body>">`. The HMAC is computed over the exact bytes Stripe
 * sent, so callers must pass the body captured before any JSON re-parsing
 * (main.ts's `rawBody` capture for `/api/webhooks/`), never a re-serialized
 * object.
 *
 * A stale timestamp is refused even with a valid signature, bounding how
 * long a captured delivery stays replayable.
 */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  toleranceSeconds: number = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  now: number = Date.now(),
): boolean {
  if (!header || !secret) return false;

  let timestamp: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i);
    const value = part.slice(i + 1);
    if (key === 't') timestamp = value;
    else if (key === 'v1') v1 = value;
  }
  if (!timestamp || !v1 || !/^\d+$/.test(timestamp)) return false;

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (age > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${raw.toString('utf8')}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(v1);
  // timingSafeEqual throws on a length mismatch rather than returning false,
  // so a provided signature of the wrong length must be rejected first.
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
