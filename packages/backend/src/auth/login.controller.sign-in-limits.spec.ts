// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';
import { loginErrorText } from './auth-page-i18n.steps';
import { PasswordSignInLimiter } from './password-sign-in-limiter';
import type { Request, Response } from 'express';

/**
 * The password form of the authorization page (POST /auth/login) counts
 * against the same sign-in attempt limits as POST /api/auth/login. While an
 * address is paused, the page shows why and no password is compared; the
 * provider buttons are never paused.
 */

function makeRes() {
  const res: any = {
    cookie() {
      return this;
    },
    clearCookie() {
      return this;
    },
    setHeader() {
      return this;
    },
    status() {
      return this;
    },
    send(payload: string) {
      this._sent = payload;
      return this;
    },
    redirect(a: string | number, b?: string) {
      this._redirect = typeof a === 'number' ? (b as string) : a;
      return this;
    },
  };
  return res as Response & Record<string, any>;
}

const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };
const ACCOUNT = { id: 'u2', email: 'a@b.com', name: 'A', passwordHash: '$2b$12$the-accounts-own-hash', emailVerified: true };

function makeController(rows: unknown[]) {
  const auth = { comparePassword: jest.fn(async () => false), verifyToken: jest.fn(() => { throw new Error('no'); }) };
  const prisma = { user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue(rows) } };
  const securityEvents = { log: jest.fn(async (_input: any) => undefined) };
  const limiter = new PasswordSignInLimiter(undefined, securityEvents as any, undefined, undefined);
  const social = {
    enabledProviders: jest.fn(() => [{ id: 'google', name: 'Google' }]),
    start: jest.fn(async () => ({ authorizationUrl: 'https://accounts.example.test/auth', bindingToken: 'bind' })),
  };
  const controller = new LoginController(
    auth as any,
    prisma as any,
    { get: jest.fn(() => undefined) } as any,
    { getOAuthSession: jest.fn(async () => undefined), getClient: jest.fn() } as any,
    { startMcp: jest.fn() } as any,
    CLOUD as any,
    { grantServers: jest.fn(), grantWholeOrganization: jest.fn(), listSelectableTargets: jest.fn() } as any,
    undefined,
    undefined,
    undefined,
    social as any,
    undefined,
    undefined,
    undefined,
    { isPasswordLoginBlocked: jest.fn(async () => false) } as any,
    limiter,
  );
  return { controller, auth, limiter, securityEvents, social };
}

const req = () =>
  ({
    ip: '203.0.113.7',
    headers: { 'user-agent': 'jest' },
    cookies: { oauth_session: 's1' },
    signedCookies: { login_csrf: 'tok' },
    secure: false,
  }) as unknown as Request;

async function post(controller: LoginController, body: Record<string, string>) {
  const res = makeRes();
  await controller.handleLogin(req(), { email: 'a@b.com', password: 'not-the-password', csrf: 'tok', ...body } as any, res);
  return res;
}

describe('LoginController: sign-in attempt limits', () => {
  it.each([
    ['an account', [ACCOUNT]],
    ['an address with no account', []],
  ])('pauses %s after 10 failures, then refuses without comparing the password', async (_label, rows) => {
    const { controller, auth } = makeController(rows);
    for (let i = 0; i < 10; i++) await post(controller, { action: 'approve' });
    expect(auth.comparePassword).toHaveBeenCalledTimes(10);

    const res = await post(controller, { action: 'approve', email: 'A@B.com' });
    expect(auth.comparePassword).toHaveBeenCalledTimes(10);
    const message = 'Too many sign-in attempts. Try again in 15 minutes, or reset your password.';
    expect(res._redirect).toBe(`/auth/login?error=${encodeURIComponent(message)}`);
    // The page's error area shows the text as it is.
    const error = new URL(`https://x${res._redirect}`).searchParams.get('error')!;
    expect(loginErrorText(error, 'en', [{ id: 'google', name: 'Google' }])).toBe(message);
  });

  it('keeps "switch account" on the form while paused', async () => {
    const { controller } = makeController([ACCOUNT]);
    for (let i = 0; i < 10; i++) await post(controller, { action: 'approve' });
    const res = await post(controller, { action: 'approve', switch: '1' });
    expect(res._redirect).toMatch(/^\/auth\/login\?switch=1&error=Too%20many%20sign-in%20attempts/);
  });

  it('records each failure with its reason, and the refusal while paused', async () => {
    const { controller, securityEvents } = makeController([]);
    for (let i = 0; i < 11; i++) await post(controller, { action: 'approve' });
    const failures = securityEvents.log.mock.calls
      .map((c) => c[0])
      .filter((e) => e.event === 'PASSWORD_LOGIN_FAILED')
      .map((e) => e.metadata.reason);
    expect(failures).toEqual([...Array(10).fill('unknown_account'), 'paused']);
    expect(securityEvents.log.mock.calls.every((c) => c[0].metadata.surface === 'authorization_page')).toBe(true);
    expect(JSON.stringify(securityEvents.log.mock.calls)).not.toContain('a@b.com');
  });

  it('does not pause "Continue with Google" for a paused address', async () => {
    const { controller, social } = makeController([ACCOUNT]);
    for (let i = 0; i < 10; i++) await post(controller, { action: 'approve' });
    const res = await post(controller, { action: 'social:google' });
    expect(social.start).toHaveBeenCalledTimes(1);
    expect(res._redirect).toBe('https://accounts.example.test/auth');
  });

  it('counts a success: the count starts again', async () => {
    const { controller, auth, limiter } = makeController([ACCOUNT]);
    for (let i = 0; i < 9; i++) await post(controller, { action: 'approve' });
    const succeeded = jest.spyOn(limiter, 'succeeded');
    auth.comparePassword.mockResolvedValueOnce(true);
    // The sign-in itself goes on to the rest of the flow, which this test does not set up.
    await post(controller, { action: 'approve' }).catch(() => undefined);
    expect(succeeded).toHaveBeenCalledWith('a@b.com', expect.objectContaining({ surface: 'authorization_page' }), expect.objectContaining({ id: 'u2' }));
    for (let i = 0; i < 9; i++) await post(controller, { action: 'approve' });
    expect((await limiter.check('a@b.com')).paused).toBe(false);
  });
});
