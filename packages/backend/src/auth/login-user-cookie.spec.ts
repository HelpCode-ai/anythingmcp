import type { Request, Response } from 'express';
import { boundLoginUser, clearLoginUserCookie, setLoginUserCookie } from './login-user-cookie';
import { LocalOAuthStrategy } from './local-oauth.strategy';

function fakeRes() {
  const res: any = {
    cookies: {} as Record<string, { value: string; options: any }>,
    cleared: [] as string[],
    cookie(name: string, value: string, options: any) {
      this.cookies[name] = { value, options };
      return this;
    },
    clearCookie(name: string) {
      this.cleared.push(name);
      return this;
    },
  };
  return res as Response & { cookies: Record<string, { value: string; options: any }>; cleared: string[] };
}
const reqWith = (cookies: Record<string, string>, signedCookies: Record<string, unknown>, path = '/callback') =>
  ({ cookies, signedCookies, headers: { host: 'mcp.test' }, path }) as unknown as Request;

const PROFILE = Buffer.from(JSON.stringify({ id: 'u1', email: 'a@b.com', username: 'a@b.com' })).toString('base64url');

describe('the sign-in cookie of the authorization pages', () => {
  it('is issued together with the id of the authorization it was made for, both signed', () => {
    const res = fakeRes();
    setLoginUserCookie(reqWith({ oauth_session: 's1' }, {}), res, PROFILE, { maxAge: 60_000, secure: true });
    expect(res.cookies.login_user).toEqual({
      value: PROFILE,
      options: { httpOnly: true, secure: true, maxAge: 60_000, sameSite: 'none', signed: true },
    });
    expect(res.cookies.login_bind.value).toBe('s1');
    expect(res.cookies.login_bind.options).toEqual(res.cookies.login_user.options);
  });

  it('uses lax cookies on plain http, as before', () => {
    const res = fakeRes();
    setLoginUserCookie(reqWith({ oauth_session: 's1' }, {}), res, PROFILE, { maxAge: 60_000, secure: false });
    expect(res.cookies.login_user.options.sameSite).toBe('lax');
  });

  it('leaves no binding behind when there is no pending authorization', () => {
    const res = fakeRes();
    setLoginUserCookie(reqWith({}, {}), res, PROFILE, { maxAge: 60_000, secure: true });
    expect(res.cookies.login_bind).toBeUndefined();
    expect(res.cleared).toContain('login_bind');
  });

  it('counts only for the authorization it was issued for', () => {
    const signed = { login_user: PROFILE, login_bind: 's1' };
    expect(boundLoginUser(reqWith({ oauth_session: 's1' }, signed))).toBe(PROFILE);
    // Another authorization started in the same browser (a second Connect, or another site).
    expect(boundLoginUser(reqWith({ oauth_session: 's2' }, signed))).toBeNull();
    // No pending authorization, no binding (a cookie from before the binding), no sign-in.
    expect(boundLoginUser(reqWith({}, signed))).toBeNull();
    expect(boundLoginUser(reqWith({ oauth_session: 's1' }, { login_user: PROFILE }))).toBeNull();
    expect(boundLoginUser(reqWith({ oauth_session: 's1' }, { login_bind: 's1' }))).toBeNull();
    // Unsigned values are never read.
    expect(boundLoginUser(reqWith({ oauth_session: 's1', login_user: PROFILE, login_bind: 's1' }, {}))).toBeNull();
  });

  it('is cleared with its binding', () => {
    const res = fakeRes();
    clearLoginUserCookie(res);
    expect(res.cleared).toEqual(['login_user', 'login_bind']);
  });
});

describe('LocalOAuthStrategy on /callback', () => {
  const run = (req: Request) => {
    const verify = jest.fn((_a: string, _r: string, profile: any, done: (err: any, user?: any) => void) => done(null, { profile }));
    const strategy = new LocalOAuthStrategy({ serverUrl: 'http://mcp.test', callbackPath: '/callback' }, verify);
    const out: { success?: any; redirect?: string } = {};
    (strategy as any).success = (user: any) => (out.success = user);
    (strategy as any).redirect = (url: string) => (out.redirect = url);
    (strategy as any).fail = () => undefined;
    (strategy as any).error = () => undefined;
    strategy.authenticate(req);
    return { out, verify };
  };

  it('accepts the sign-in made for this authorization', () => {
    const { out, verify } = run(reqWith({ oauth_session: 's1' }, { login_user: PROFILE, login_bind: 's1' }));
    expect(verify).toHaveBeenCalled();
    expect(out.success.profile.id).toBe('u1');
  });

  it('sends a sign-in made for another authorization back to the sign-in page', () => {
    const { out, verify } = run(reqWith({ oauth_session: 's2' }, { login_user: PROFILE, login_bind: 's1' }));
    expect(verify).not.toHaveBeenCalled();
    expect(out.redirect).toBe('http://mcp.test/auth/login');
  });

  it('does the same for a cookie without a binding', () => {
    const { out, verify } = run(reqWith({ oauth_session: 's1' }, { login_user: PROFILE }));
    expect(verify).not.toHaveBeenCalled();
    expect(out.redirect).toBe('http://mcp.test/auth/login');
  });

  it('never reads the cookie on /authorize', () => {
    const { out, verify } = run(reqWith({ oauth_session: 's1' }, { login_user: PROFILE, login_bind: 's1' }, '/authorize'));
    expect(verify).not.toHaveBeenCalled();
    expect(out.redirect).toBe('http://mcp.test/auth/login');
  });
});
