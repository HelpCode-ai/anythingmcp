// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';
import { SocialAuthError } from './social/social-auth.service';
import type { Request, Response } from 'express';

function makeRes() {
  const res: any = {
    _cookies: {} as Record<string, { value: string; options: any }>,
    _cleared: [] as string[],
    _headers: {} as Record<string, string>,
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
  return res as Response & Record<string, any>;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: {},
    cookies: {},
    signedCookies: {},
    secure: false,
    originalUrl: '/auth/social/google/callback?code=c&state=s',
    ...overrides,
  } as unknown as Request;
}

const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };
const SELF_HOSTED = { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true };

function makeController(deployment = CLOUD, social: any = makeSocial()) {
  const config = {
    get: jest.fn((k: string) => (k === 'FRONTEND_URL' ? 'https://cloud.example' : undefined)),
  };
  const controller = new LoginController(
    { comparePassword: jest.fn(), verifyToken: jest.fn(() => { throw new Error('no'); }) } as any,
    { user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } } as any,
    config as any,
    {
      // A pending authorization exists for the `oauth_session` cookie 's1'.
      getOAuthSession: jest.fn(async (id: string) =>
        id === 's1'
          ? { sessionId: 's1', state: 'x', clientId: 'c1', redirectUri: 'https://claude.ai/api/mcp/auth_callback', expiresAt: Date.now() + 60_000 }
          : undefined,
      ),
      getClient: jest.fn(async () => ({ client_id: 'c1', client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })),
    } as any,
    { startMcp: jest.fn() } as any,
    deployment as any,
    { grantServers: jest.fn(), grantWholeOrganization: jest.fn(), listSelectableTargets: jest.fn() } as any,
    undefined,
    undefined,
    undefined,
    social,
  );
  return { controller, social };
}

function makeSocial() {
  return {
    enabledProviders: jest.fn(() => [
      { id: 'google', name: 'Google' },
      { id: 'microsoft', name: 'Microsoft' },
    ]),
    start: jest.fn(async () => ({ authorizationUrl: 'https://accounts.google.com/auth?x', bindingToken: 'bind' })),
    complete: jest.fn(),
    logFailure: jest.fn(async () => undefined),
  };
}

describe('LoginController — social sign-in on the MCP consent page', () => {
  it('offers the enabled providers on cloud, above the password form', async () => {
    const { controller } = makeController();
    const res = makeRes();
    await controller.showLoginPage(undefined as any, undefined as any, makeReq({ cookies: { oauth_session: 's1' } }), res);
    const html: string = res._sent;
    expect(html).toContain('value="social:google"');
    expect(html).toContain('Continue with Microsoft');
    expect(html.indexOf('value="social:google"')).toBeLessThan(html.indexOf('id="email"'));
    // Social buttons are submit buttons of the CSRF-protected form.
    expect(html.indexOf('<form method="POST" action="/auth/login">')).toBeLessThan(
      html.indexOf('value="social:google"'),
    );
  });

  it('offers none on a self-hosted instance', async () => {
    const { controller } = makeController(SELF_HOSTED);
    const res = makeRes();
    await controller.showLoginPage(undefined as any, undefined as any, makeReq({ cookies: { oauth_session: 's1' } }), res);
    expect(res._sent).not.toContain('social:');
  });

  it('offers none without a pending authorization, where the round trip could only fail', async () => {
    const { controller } = makeController();
    const res = makeRes();
    await controller.showLoginPage(undefined as any, undefined as any, makeReq(), res);
    expect(res._sent).not.toContain('social:');
  });

  it('starts the round trip bound to the pending authorization', async () => {
    const { controller, social } = makeController();
    const res = makeRes();
    await controller.handleLogin(
      makeReq({ signedCookies: { login_csrf: 'tok' }, cookies: { oauth_session: 'sess-1' } }),
      { email: '', password: '', csrf: 'tok', action: 'social:google' },
      res,
    );
    expect(social.start).toHaveBeenCalledWith({ provider: 'google', surface: 'MCP', oauthSessionId: 'sess-1' });
    expect(res._redirect).toBe('https://accounts.google.com/auth?x');
    expect(res._cookies.amcp_social_bind).toMatchObject({
      value: 'bind',
      options: expect.objectContaining({ httpOnly: true, path: '/auth/social', sameSite: 'lax' }),
    });
  });

  it('refuses a social start without the CSRF token', async () => {
    const { controller, social } = makeController();
    const res = makeRes();
    await controller.handleLogin(
      makeReq({ signedCookies: {}, cookies: { oauth_session: 'sess-1' } }),
      { email: '', password: '', csrf: 'forged', action: 'social:google' },
      res,
    );
    expect(social.start).not.toHaveBeenCalled();
    expect(res._redirect).toContain('/auth/login?error=');
  });

  describe('GET /auth/social/:provider/callback', () => {
    it('answers 404 on a self-hosted instance', async () => {
      const { controller, social } = makeController(SELF_HOSTED);
      const res = makeRes();
      await controller.socialCallback('google', makeReq(), res);
      expect(res._status).toBe(404);
      expect(social.complete).not.toHaveBeenCalled();
    });

    it('rebuilds the callback URL on the configured origin, ignoring forwarded hosts', async () => {
      const { controller, social } = makeController();
      social.complete.mockResolvedValue({ kind: 'LOGIN', handoffCode: 'h', returnTo: '/' });
      await controller.socialCallback(
        'google',
        makeReq({ headers: { 'x-forwarded-host': 'evil.tld' }, cookies: { amcp_social_bind: 'b', oauth_session: 'o' } }),
        makeRes(),
      );
      const [, url, browser] = social.complete.mock.calls[0];
      expect(url.href).toBe('https://cloud.example/auth/social/google/callback?code=c&state=s');
      expect(browser).toEqual({ bindingToken: 'b', oauthSessionId: 'o' });
    });

    it('finishes an MCP authorization like a password sign-in', async () => {
      const { controller, social } = makeController();
      const user = { id: 'u1', email: 'ann@example.com', name: 'Ann' };
      social.complete.mockResolvedValue({ kind: 'MCP', provider: 'google', user });
      const completeSignIn = jest.spyOn(controller as any, 'completeSignIn').mockResolvedValue(undefined);
      const res = makeRes();
      await controller.socialCallback('google', makeReq(), res);
      // The provider goes along: the next page's dashboard links sign in with it.
      expect(completeSignIn).toHaveBeenCalledWith(expect.anything(), res, user, 'google');
      expect(res._cleared).toContain('amcp_social_bind');
    });

    it('hands a dashboard sign-in to the frontend with a one-time code', async () => {
      const { controller, social } = makeController();
      social.complete.mockResolvedValue({ kind: 'LOGIN', handoffCode: 'h1', returnTo: '/connectors' });
      const res = makeRes();
      await controller.socialCallback('google', makeReq(), res);
      expect(res._redirect).toBe('https://cloud.example/login?social=h1&redirect=%2Fconnectors');
    });

    it('returns a linked account to Settings', async () => {
      const { controller, social } = makeController();
      social.complete.mockResolvedValue({ kind: 'LINK', returnTo: '/settings', provider: 'github' });
      const res = makeRes();
      await controller.socialCallback('github', makeReq(), res);
      expect(res._redirect).toBe('https://cloud.example/settings?linked=github');
    });

    it('shows an MCP failure on the consent page, and logs it', async () => {
      const { controller, social } = makeController();
      social.complete.mockRejectedValue(new SocialAuthError('x', 'Sign-in was cancelled.', 'MCP'));
      const res = makeRes();
      await controller.socialCallback('google', makeReq(), res);
      expect(res._redirect).toBe(`/auth/login?error=${encodeURIComponent('Sign-in was cancelled.')}`);
      expect(social.logFailure).toHaveBeenCalled();
    });

    it('shows other failures on the dashboard sign-in page, without internals', async () => {
      const { controller, social } = makeController();
      social.complete.mockRejectedValue(new Error('database exploded'));
      const res = makeRes();
      await controller.socialCallback('google', makeReq(), res);
      expect(res._redirect).toBe(
        `https://cloud.example/login?error=${encodeURIComponent('Sign-in failed. Please try again.')}`,
      );
    });
  });
});

/**
 * The page after Approve for an empty workspace links to the dashboard ("add
 * an app", "add a card"). Someone who signed in on the consent page with a
 * social provider has no dashboard session, so those links sign them in with
 * the same provider first instead of showing the sign-in form.
 */
describe('LoginController — dashboard links after a social sign-in on the consent page', () => {
  function offerController() {
    const { controller } = makeController();
    (controller as any).prisma = {
      user: { findUnique: jest.fn(async () => ({ organizationId: 'o1', email: 'ann@example.com' })) },
      organizationMember: { findFirst: jest.fn(async () => ({ role: 'ADMIN' })) },
      connector: { count: jest.fn(async () => 0) },
    };
    (controller as any).licenseGuard = {
      getTrialState: jest.fn(async () => ({ active: true, cardTrialAvailable: true, endsAt: new Date('2026-10-29T12:00:00Z') })),
    };
    return controller;
  }
  const offer = (controller: any, provider?: string) => {
    const res = makeRes();
    return controller
      .maybeOfferFirstConnector(makeReq({ cookies: { oauth_session: 's1' } }), res, 'u1', 'enc', 'https://cloud.example/callback', provider)
      .then((shown: boolean) => ({ shown, html: String(res._sent ?? '') }));
  };

  it('signs in with the same provider on the way to the dashboard', async () => {
    const { shown, html } = await offer(offerController(), 'google');
    expect(shown).toBe(true);
    expect(html).toContain('https://cloud.example/login?continueWith=google&amp;redirect=%2Fwelcome');
    expect(html).toContain(
      'https://cloud.example/login?continueWith=google&amp;redirect=%2Fstart-trial%3Fsource%3Dpost_approve',
    );
  });

  it('links straight to the dashboard after a password sign-in', async () => {
    const { html } = await offer(offerController());
    expect(html).toContain('href="https://cloud.example/welcome"');
    expect(html).toContain('https://cloud.example/start-trial?source=post_approve');
    expect(html).not.toContain('continueWith');
  });
});
