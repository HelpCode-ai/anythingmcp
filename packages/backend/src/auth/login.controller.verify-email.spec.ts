// `openid-client` is ESM-only and this suite reaches it transitively through
// LoginController -> SsoService. Nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';
import type { Request, Response } from 'express';

/**
 * Cloud: an account whose email address is not verified must not finish the
 * MCP authorization with its password alone. The client would get a token
 * that /mcp refuses on every call (EmailVerifiedGuard); the consent page asks
 * for the code first.
 */

interface FakeRes extends Response {
  _cookies: Record<string, { value: string; options: any }>;
  _cleared: string[];
  _headers: Record<string, string>;
  _sent?: string;
  _redirect?: string;
  _status: number;
}

function makeRes(): FakeRes {
  const res: any = {
    _cookies: {},
    _cleared: [],
    _headers: {},
    _status: 200,
    cookie(name: string, value: string, options: any) {
      this._cookies[name] = { value, options };
      return this;
    },
    clearCookie(name: string) {
      this._cleared.push(name);
      return this;
    },
    setHeader(name: string, value: string) {
      this._headers[name] = value;
      return this;
    },
    status(code: number) {
      this._status = code;
      return this;
    },
    send(payload: string) {
      this._sent = payload;
      return this;
    },
    redirect(url: string) {
      this._redirect = url;
      return this;
    },
  };
  return res as FakeRes;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: { host: 'mcp.test' },
    cookies: {},
    signedCookies: {},
    secure: false,
    ...overrides,
  } as unknown as Request;
}

const UNVERIFIED = {
  id: 'u1',
  email: 'ada.lovelace@example.com',
  name: 'Ada',
  passwordHash: 'hash',
  emailVerified: false,
  passwordLoginDisabled: false,
};

function setup(opts: { cloud?: boolean; user?: Record<string, unknown> } = {}) {
  const cloud = opts.cloud !== false;
  const user = { ...UNVERIFIED, ...(opts.user ?? {}) };
  const prisma = {
    user: {
      findMany: jest.fn().mockResolvedValue([user]),
      findUnique: jest.fn().mockResolvedValue(user),
    },
  };
  const authService = {
    comparePassword: jest.fn().mockResolvedValue(true),
    verifyToken: jest.fn(() => {
      throw new Error('invalid');
    }),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const store = { getOAuthSession: jest.fn(), getClient: jest.fn() };
  const grants = {
    grantServers: jest.fn().mockResolvedValue([]),
    grantWholeOrganization: jest.fn().mockResolvedValue(true),
    listSelectableTargets: jest.fn().mockResolvedValue([]),
    resolve: jest.fn().mockResolvedValue(null),
  };
  const verification = {
    codesSentWithin: jest.fn().mockResolvedValue(0),
    sendCode: jest.fn().mockResolvedValue(true),
    verifyCode: jest.fn().mockResolvedValue(false),
  };
  const social = {
    enabledProviders: jest.fn(() => [{ id: 'google', name: 'Google' }]),
    start: jest.fn().mockResolvedValue({ authorizationUrl: 'https://accounts.google.test/auth', bindingToken: 'bind' }),
  };
  const controller = new LoginController(
    authService as any,
    prisma as any,
    config as any,
    store as any,
    { startMcp: jest.fn() } as any,
    cloud
      ? ({ mode: 'cloud', isCloud: () => true, isSelfHosted: () => false } as any)
      : ({ mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true } as any),
    grants as any,
    undefined,
    undefined,
    undefined,
    social as any,
    undefined,
    undefined,
    verification as any,
  );
  return { controller, prisma, verification, social, store };
}

const signIn = async (controller: LoginController) => {
  const res = makeRes();
  await controller.handleLogin(
    makeReq({ signedCookies: { login_csrf: 'tok' } }),
    { email: 'ada.lovelace@example.com', password: 'pw', csrf: 'tok', action: 'approve' },
    res,
  );
  return res;
};

const PENDING = { pending_verify: 'u1', verify_csrf: 'vtok' };

/** The code step's form posted to /auth/verify-email, as the browser sends it after the page above. */
const submitCode = async (
  controller: LoginController,
  body: Record<string, string>,
  signedCookies: Record<string, string> = PENDING,
) => {
  const res = makeRes();
  await controller.handleEmailCode(makeReq({ signedCookies }), { csrf: 'vtok', ...body }, res);
  return res;
};

/** One of the step's other buttons, which post to their own routes (`formaction`). */
const press = async (
  controller: LoginController,
  button: 'resend' | 'continue' | 'social',
  signedCookies: Record<string, string> = PENDING,
) => {
  const res = makeRes();
  const req = makeReq({ signedCookies });
  const body = { csrf: 'vtok' };
  if (button === 'resend') await controller.resendEmailCode(req, body, res);
  else if (button === 'continue') await controller.continueAfterEmailLink(req, body, res);
  else await controller.socialFromEmailCode('google', req, body, res);
  return res;
};

describe('LoginController — email verification on the authorization page (Cloud)', () => {
  describe('password sign-in of an unverified account', () => {
    it('shows the code step and issues nothing the callback could turn into a token', async () => {
      const { controller, verification } = setup();
      const res = await signIn(controller);

      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._cookies['amcp_signin']).toBeUndefined();
      expect(res._redirect).toBeUndefined();
      expect(res._sent).toContain('Check your email');
      expect(res._sent).toContain('action="/auth/verify-email"');
      // Each other button has its own route; no form field picks what runs.
      expect(res._sent).toContain('formaction="/auth/verify-email/resend"');
      expect(res._sent).toContain('formaction="/auth/verify-email/continue"');
      expect(res._sent).not.toContain('name="action"');
      expect(res._sent).toContain('autocomplete="one-time-code"');
      // Masked, never the whole address.
      expect(res._sent).toContain('ad***@example.com');
      expect(res._sent).not.toContain('ada.lovelace@example.com');
      expect(res._headers['Content-Security-Policy']).toBe("frame-ancestors 'none'");

      expect(res._cookies['pending_verify'].value).toBe('u1');
      for (const name of ['pending_verify', 'verify_csrf']) {
        expect(res._cookies[name].options).toEqual(
          expect.objectContaining({ httpOnly: true, signed: true, maxAge: 15 * 60 * 1000 }),
        );
      }
      expect(res._sent).toContain(`value="${res._cookies['verify_csrf'].value}"`);
      expect(res._cleared).toContain('login_csrf');
      expect(verification.sendCode).toHaveBeenCalledWith('u1', 'ada.lovelace@example.com', { sendInBackground: true });
    });

    it('offers the social providers inside an authorize flow, each on its own route', async () => {
      const { controller, store } = setup();
      store.getOAuthSession.mockResolvedValue({ sessionId: 's1', clientId: 'c1', redirectUri: 'https://claude.ai/cb' });
      store.getClient.mockResolvedValue({ client_id: 'c1', client_name: 'Claude' });
      const res = makeRes();
      await controller.handleLogin(
        makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: 'tok' } }),
        { email: 'ada.lovelace@example.com', password: 'pw', csrf: 'tok', action: 'approve' },
        res,
      );
      expect(res._sent).toContain('formaction="/auth/verify-email/social/google"');
      expect(res._sent).toContain('Continue with Google');
      expect(res._sent).toContain('to finish connecting <strong>Claude</strong>');
      expect(res._cookies['login_user']).toBeUndefined();
    });

    it('sends no second code within a minute of the last one', async () => {
      const { controller, verification } = setup();
      verification.codesSentWithin.mockResolvedValue(1);
      const res = await signIn(controller);
      expect(verification.sendCode).not.toHaveBeenCalled();
      expect(res._sent).toContain('Check your email');
    });

    it('sends none past the hourly cap, and says so', async () => {
      const { controller, verification } = setup();
      verification.codesSentWithin.mockImplementation(async (_id: string, ms: number) => (ms > 60_000 ? 5 : 0));
      const res = await signIn(controller);
      expect(verification.sendCode).not.toHaveBeenCalled();
      expect(res._sent).toContain('many codes in the last hour');
    });

    it('lets a verified account through to /callback as before', async () => {
      const { controller, verification } = setup({ user: { emailVerified: true } });
      const res = await signIn(controller);
      expect(res._cookies['login_user']).toBeDefined();
      expect(res._redirect).toBe('http://mcp.test/callback');
      expect(verification.sendCode).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/verify-email', () => {
    it('completes the sign-in with the right code', async () => {
      const { controller, verification } = setup();
      verification.verifyCode.mockResolvedValue(true);
      const res = await submitCode(controller, { code: ' 123 456 ' });

      expect(verification.verifyCode).toHaveBeenCalledWith('u1', '123456');
      expect(res._cookies['login_user'].options.signed).toBe(true);
      expect(res._redirect).toBe('http://mcp.test/callback');
      expect(res._cleared).toEqual(expect.arrayContaining(['pending_verify', 'verify_csrf']));
    });

    it('refuses a wrong or expired code and stays on the step', async () => {
      const { controller, verification } = setup();
      const res = await submitCode(controller, { code: '000000' });

      expect(verification.verifyCode).toHaveBeenCalledWith('u1', '000000');
      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._redirect).toBeUndefined();
      expect(res._sent).toContain('That code is wrong or has expired');
      // A fresh CSRF token for the next try.
      expect(res._cookies['verify_csrf']).toBeDefined();
    });

    it('refuses a malformed code, and bounds what it looks up', async () => {
      const { controller, verification } = setup();
      const res = await submitCode(controller, { code: '12ab'.repeat(20) });
      expect(verification.verifyCode).toHaveBeenCalledWith('u1', '12ab'.repeat(4));
      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._sent).toContain('That code is wrong or has expired');
    });

    it('is refused without a matching CSRF token', async () => {
      const { controller, verification } = setup();
      const res = makeRes();
      await controller.handleEmailCode(
        makeReq({ signedCookies: { pending_verify: 'u1', verify_csrf: 'other' } }),
        { csrf: 'vtok', code: '123456' },
        res,
      );
      expect(verification.verifyCode).not.toHaveBeenCalled();
      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._redirect).toMatch(/^\/auth\/login\?error=/);
    });

    it('is refused without the pending sign-in', async () => {
      const { controller, verification } = setup();
      const res = await submitCode(controller, { code: '123456' }, { verify_csrf: 'vtok' });
      expect(verification.verifyCode).not.toHaveBeenCalled();
      expect(res._redirect).toMatch(/^\/auth\/login\?error=/);
    });

    it('starts over when the account became SSO-only meanwhile', async () => {
      const { controller, verification } = setup({ user: { passwordLoginDisabled: true } });
      verification.verifyCode.mockResolvedValue(true);
      const res = await submitCode(controller, { code: '123456' });
      expect(verification.verifyCode).not.toHaveBeenCalled();
      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._redirect).toMatch(/^\/auth\/login\?error=/);
    });

  });

  describe('POST /auth/verify-email/resend', () => {
    it('sends a new code, at most once a minute', async () => {
      const { controller, verification } = setup();
      let res = await press(controller, 'resend');
      expect(verification.sendCode).toHaveBeenCalledTimes(1);
      expect(res._sent).toContain('A new code is on its way');

      verification.codesSentWithin.mockResolvedValue(1);
      res = await press(controller, 'resend');
      expect(verification.sendCode).toHaveBeenCalledTimes(1);
      expect(res._sent).toContain('less than a minute ago');
      expect(res._cookies['login_user']).toBeUndefined();
    });

    it('sends none past the hourly cap', async () => {
      const { controller, verification } = setup();
      verification.codesSentWithin.mockImplementation(async (_id: string, ms: number) => (ms > 60_000 ? 5 : 0));
      const res = await press(controller, 'resend');
      expect(verification.sendCode).not.toHaveBeenCalled();
      expect(res._sent).toContain('many codes in the last hour');
    });

    it('needs the CSRF token and the pending sign-in like the code route', async () => {
      const { controller, verification } = setup();
      let res = await press(controller, 'resend', { pending_verify: 'u1', verify_csrf: 'other' });
      expect(res._redirect).toMatch(/^\/auth\/login\?error=/);
      res = await press(controller, 'resend', { verify_csrf: 'vtok' });
      expect(res._redirect).toMatch(/^\/auth\/login\?error=/);
      expect(verification.sendCode).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/verify-email/continue', () => {
    it('continues once the address was verified through the email link', async () => {
      const { controller, verification } = setup({ user: { emailVerified: true } });
      const res = await press(controller, 'continue');
      expect(verification.verifyCode).not.toHaveBeenCalled();
      expect(res._cookies['login_user']).toBeDefined();
      expect(res._redirect).toBe('http://mcp.test/callback');
    });

    it('keeps asking before the link was opened', async () => {
      const { controller } = setup();
      const res = await press(controller, 'continue');
      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._sent).toContain('not verified yet');
    });

    it('is refused without a matching CSRF token', async () => {
      const { controller } = setup({ user: { emailVerified: true } });
      const res = await press(controller, 'continue', { pending_verify: 'u1', verify_csrf: 'other' });
      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._redirect).toMatch(/^\/auth\/login\?error=/);
    });
  });

  describe('POST /auth/verify-email/social/:provider', () => {
    it('hands over to the provider, which verifies the address', async () => {
      const { controller, social } = setup();
      const res = await press(controller, 'social');
      expect(social.start).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', surface: 'MCP' }));
      expect(res._redirect).toBe('https://accounts.google.test/auth');
      expect(res._cleared).toEqual(expect.arrayContaining(['pending_verify', 'verify_csrf']));
      expect(res._cookies['login_user']).toBeUndefined();
    });

    it('is refused without the pending sign-in', async () => {
      const { controller, social } = setup();
      const res = await press(controller, 'social', { verify_csrf: 'vtok' });
      expect(social.start).not.toHaveBeenCalled();
      expect(res._redirect).toMatch(/^\/auth\/login\?error=/);
    });
  });

  describe('self-hosted', () => {
    it('signs an unverified account in as before (verification is not enforced there)', async () => {
      const { controller, verification } = setup({ cloud: false });
      const res = await signIn(controller);
      expect(res._cookies['login_user']).toBeDefined();
      expect(res._redirect).toBe('http://mcp.test/callback');
      expect(verification.sendCode).not.toHaveBeenCalled();
    });

    it('has no code step', async () => {
      const { controller, verification, social } = setup({ cloud: false });
      expect((await submitCode(controller, { code: '123456' }))._status).toBe(404);
      expect((await press(controller, 'resend'))._status).toBe(404);
      expect((await press(controller, 'continue'))._status).toBe(404);
      expect((await press(controller, 'social'))._status).toBe(404);
      expect(verification.verifyCode).not.toHaveBeenCalled();
      expect(verification.sendCode).not.toHaveBeenCalled();
      expect(social.start).not.toHaveBeenCalled();
    });
  });
});
