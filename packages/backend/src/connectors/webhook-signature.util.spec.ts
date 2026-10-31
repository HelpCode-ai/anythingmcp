import { createHmac } from 'crypto';
import { verifyStripeSignature } from './webhook-signature.util';

const secret = 'whsec_test_secret_123';
const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { amount: 4200 } });
const raw = Buffer.from(body, 'utf8');

function header(timestamp: number, payload: string, signingSecret = secret): string {
  const sig = createHmac('sha256', signingSecret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

describe('verifyStripeSignature', () => {
  it('accepts a valid signature with a fresh timestamp', () => {
    const now = Date.now();
    const h = header(Math.floor(now / 1000), body);
    expect(verifyStripeSignature(raw, h, secret, 300, now)).toBe(true);
  });

  it('rejects the wrong secret', () => {
    const h = header(Math.floor(Date.now() / 1000), body);
    expect(verifyStripeSignature(raw, h, 'wrong_secret')).toBe(false);
  });

  it('rejects a tampered body', () => {
    const h = header(Math.floor(Date.now() / 1000), body);
    expect(verifyStripeSignature(Buffer.from(body + 'x'), h, secret)).toBe(false);
  });

  it('rejects a timestamp older than the tolerance window', () => {
    const now = Date.now();
    const staleTimestamp = Math.floor((now - 11 * 60_000) / 1000);
    const h = header(staleTimestamp, body);
    expect(verifyStripeSignature(raw, h, secret, 300, now)).toBe(false);
  });

  it('rejects a malformed header missing v1', () => {
    expect(verifyStripeSignature(raw, `t=${Math.floor(Date.now() / 1000)}`, secret)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyStripeSignature(raw, undefined, secret)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(verifyStripeSignature(raw, 't=notanumber,v1=abc', secret)).toBe(false);
  });

  it('does not throw on a provided signature of the wrong length', () => {
    expect(() => verifyStripeSignature(raw, `t=${Math.floor(Date.now() / 1000)},v1=short`, secret)).not.toThrow();
    expect(verifyStripeSignature(raw, `t=${Math.floor(Date.now() / 1000)},v1=short`, secret)).toBe(false);
  });

  it('rejects an empty secret', () => {
    const h = header(Math.floor(Date.now() / 1000), body);
    expect(verifyStripeSignature(raw, h, '')).toBe(false);
  });
});
