import {
  RECENT_SIGN_IN_COOKIE,
  RECENT_SIGN_IN_MAX_AGE_MS,
  readRecentSignIn,
  setRecentSignInCookie,
} from './recent-sign-in.util';

describe('recent sign-in cookie', () => {
  function issued(userId: string, now: number) {
    const res: any = { cookie: jest.fn() };
    setRecentSignInCookie(res, userId, true, now);
    const [name, value, options] = res.cookie.mock.calls[0];
    return { name, value, options };
  }

  it('is signed, httpOnly, same-site and lasts as long as a dashboard session', () => {
    const { name, options } = issued('u1', Date.now());
    expect(name).toBe(RECENT_SIGN_IN_COOKIE);
    expect(options).toEqual(
      expect.objectContaining({ httpOnly: true, signed: true, secure: true, sameSite: 'lax', path: '/', maxAge: RECENT_SIGN_IN_MAX_AGE_MS }),
    );
  });

  it('reads back the user and the time of the sign-in, only from the signed cookies', () => {
    const now = Date.parse('2026-11-02T16:00:00Z');
    const { value } = issued('u1', now);
    expect(readRecentSignIn({ signedCookies: { [RECENT_SIGN_IN_COOKIE]: value } } as any, now)).toEqual({
      userId: 'u1',
      iat: now / 1000,
    });
    // An unsigned (forgeable) cookie of the same name is never read.
    expect(readRecentSignIn({ cookies: { [RECENT_SIGN_IN_COOKIE]: value }, signedCookies: {} } as any, now)).toBeNull();
    // cookie-parser sets a tampered signed cookie to false.
    expect(readRecentSignIn({ signedCookies: { [RECENT_SIGN_IN_COOKIE]: false } } as any, now)).toBeNull();
  });

  it('is refused once older than its lifetime, or malformed', () => {
    const now = Date.parse('2026-11-02T16:00:00Z');
    const { value } = issued('u1', now);
    const later = now + RECENT_SIGN_IN_MAX_AGE_MS + 1000;
    expect(readRecentSignIn({ signedCookies: { [RECENT_SIGN_IN_COOKIE]: value } } as any, later)).toBeNull();
    for (const bad of ['', 'not-base64-json', Buffer.from('{"uid":""}').toString('base64url'), Buffer.from('{"uid":"u1"}').toString('base64url')]) {
      expect(readRecentSignIn({ signedCookies: { [RECENT_SIGN_IN_COOKIE]: bad } } as any, now)).toBeNull();
    }
  });
});
