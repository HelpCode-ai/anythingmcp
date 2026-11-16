import cookieParser from 'cookie-parser';
import { createHmac } from 'crypto';
import { cookieSecrets } from './cookie-secrets.util';

/** The format cookie-parser verifies: value.base64(HMAC-SHA256) without padding. */
function sign(value: string, secret: string): string {
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '')}`;
}

function parse(secrets: string[], cookie: string): Record<string, unknown> {
  const req: any = { headers: { cookie }, secret: undefined };
  cookieParser(secrets)(req, {} as any, () => undefined);
  return req.signedCookies;
}

describe('cookieSecrets', () => {
  it('uses JWT_SECRET alone when COOKIE_SECRET is not set', () => {
    expect(cookieSecrets({ JWT_SECRET: 'jwt' })).toEqual(['jwt']);
    expect(cookieSecrets({ JWT_SECRET: 'jwt', COOKIE_SECRET: '  ' })).toEqual(['jwt']);
  });

  it('signs with COOKIE_SECRET and keeps JWT_SECRET for verification', () => {
    expect(cookieSecrets({ COOKIE_SECRET: 'cookie', JWT_SECRET: 'jwt' })).toEqual(['cookie', 'jwt']);
  });

  it('lists a secret once when both values are equal', () => {
    expect(cookieSecrets({ COOKIE_SECRET: 'same', JWT_SECRET: 'same' })).toEqual(['same']);
  });

  it('uses COOKIE_SECRET alone when JWT_SECRET is not set', () => {
    expect(cookieSecrets({ COOKIE_SECRET: 'cookie' })).toEqual(['cookie']);
  });

  it('throws when neither secret is set', () => {
    expect(() => cookieSecrets({})).toThrow(/must be set/);
  });

  it('accepts a cookie signed before COOKIE_SECRET was added, and rejects a forged one', () => {
    const secrets = cookieSecrets({ COOKIE_SECRET: 'cookie', JWT_SECRET: 'jwt' });
    const old = `login_user=${encodeURIComponent('s:' + sign('u1', 'jwt'))}`;
    const fresh = `login_user=${encodeURIComponent('s:' + sign('u2', 'cookie'))}`;
    const forged = `login_user=${encodeURIComponent('s:' + sign('u3', 'other'))}`;
    expect(parse(secrets, old).login_user).toBe('u1');
    expect(parse(secrets, fresh).login_user).toBe('u2');
    expect(parse(secrets, forged).login_user).toBe(false);
  });
});
