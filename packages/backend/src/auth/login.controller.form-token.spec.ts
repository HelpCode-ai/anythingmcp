// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';
import { followPausedPageInPlace } from './paused-page.spec-helper';
import type { Request, Response } from 'express';

// The page after approving is reached through a redirect: follow it in place.
followPausedPageInPlace();

/**
 * The sign-in form's CSRF token (`login_csrf`): bound to the pending
 * authorization, and the same one again on a reload, a second click or the
 * back button from a provider's page.
 */

function makeRes() {
  const res: any = {
    _cookies: {} as Record<string, { value: string; options: any }>,
    _cleared: [] as string[],
    _headers: {} as Record<string, string>,
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
    status() {
      return this;
    },
    send(payload: string) {
      this._sent = payload;
      return this;
    },
    redirect(a: string | number, b?: string) {
      // Express: redirect(url) or redirect(status, url).
      this._redirect = typeof a === 'number' ? (b as string) : a;
      return this;
    },
  };
  return res as Response & Record<string, any>;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return { headers: {}, cookies: {}, signedCookies: {}, secure: false, ...overrides } as unknown as Request;
}

const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };
const SELF_HOSTED = { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true };

function makeController(deployment = CLOUD) {
  const social = {
    enabledProviders: jest.fn(() => [{ id: 'google', name: 'Google' }]),
    start: jest.fn(async () => ({ authorizationUrl: 'https://accounts.google.com/auth?x', bindingToken: 'bind' })),
    complete: jest.fn(),
    logFailure: jest.fn(async () => undefined),
  };
  const sso = { startMcp: jest.fn(async () => ({ authorizationUrl: 'https://idp.example/authorize?x' })) };
  const auth = { comparePassword: jest.fn(), verifyToken: jest.fn(() => { throw new Error('no'); }) };
  const prisma = { user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } };
  const controller = new LoginController(
    auth as any,
    prisma as any,
    { get: jest.fn((k: string) => (k === 'FRONTEND_URL' ? 'https://cloud.example' : undefined)) } as any,
    {
      // Two pending authorizations exist: `oauth_session` cookies 's1' and 's2'.
      getOAuthSession: jest.fn(async (id: string) =>
        id === 's1' || id === 's2'
          ? { sessionId: id, state: 'x', clientId: 'c1', redirectUri: 'https://claude.ai/api/mcp/auth_callback', expiresAt: Date.now() + 60_000 }
          : undefined,
      ),
      getClient: jest.fn(async () => ({ client_id: 'c1', client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })),
    } as any,
    sso as any,
    deployment as any,
    {
      grantServers: jest.fn().mockResolvedValue([]),
      grantWholeOrganization: jest.fn().mockResolvedValue(true),
      listSelectableTargets: jest.fn().mockResolvedValue([]),
      resolve: jest.fn().mockResolvedValue(null),
      keepVisible: jest.fn(async (_userId: string, servers: unknown[]) => servers),
      restrictedIn: jest.fn().mockResolvedValue(false),
    } as any,
    undefined,
    undefined,
    undefined,
    social as any,
  );
  return { controller, social, sso, auth, prisma };
}

/** Shows the sign-in page and returns what the browser now holds: the cookie and the form's token. */
async function showForm(controller: LoginController, req: Request) {
  const res = makeRes();
  await controller.showLoginPage(undefined as any, undefined as any, req, res);
  const cookie: string = res._cookies.login_csrf.value;
  const field = /name="csrf" value="([^"]+)"/.exec(res._sent as string)![1];
  return { res, cookie, field };
}

describe('LoginController: the sign-in form token', () => {
  describe('GET /auth/login', () => {
    it('binds the cookie to the pending authorization and keeps the binding out of the form', async () => {
      const { controller } = makeController();
      const { res, cookie, field } = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      const [token, binding] = cookie.split('.');
      expect(field).toBe(token);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(binding).toMatch(/^[A-Za-z0-9_-]{22}$/);
      // The digest names the authorization without holding its id.
      expect(cookie).not.toContain('s1');
      expect(res._sent).not.toContain(binding);
      expect(res._cookies.login_csrf.options).toEqual(
        expect.objectContaining({ httpOnly: true, signed: true, maxAge: 10 * 60 * 1000 }),
      );
    });

    it('hands out the same token again while the browser holds the same authorization', async () => {
      const { controller } = makeController();
      const first = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      // A reload, a second tab, or the page coming back after an error.
      const again = await showForm(
        controller,
        makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: first.cookie } }),
      );
      expect(again.field).toBe(first.field);
      expect(again.cookie).toBe(first.cookie);
    });

    it('issues a new token for another pending authorization', async () => {
      const { controller } = makeController();
      const first = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      const other = await showForm(
        controller,
        makeReq({ cookies: { oauth_session: 's2' }, signedCookies: { login_csrf: first.cookie } }),
      );
      expect(other.field).not.toBe(first.field);
      expect(other.cookie.split('.')[1]).not.toBe(first.cookie.split('.')[1]);
    });

    it('shows no form and issues no token outside a pending authorization', async () => {
      const { controller } = makeController();
      const res = makeRes();
      await controller.showLoginPage(undefined as any, undefined as any, makeReq(), res);
      // The "no longer open" page: signing in here could only end in a refused callback.
      expect(res._sent).toContain('This connection request is no longer open');
      expect(res._sent).not.toContain('name="csrf"');
      expect(res._cookies.login_csrf).toBeUndefined();
    });

    it('does not carry a token issued outside an authorization into one', async () => {
      const { controller } = makeController();
      // A bare token, as cookies issued before the binding existed were.
      const bare = 'bare-token-from-before';
      const inside = await showForm(
        controller,
        makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: bare } }),
      );
      expect(inside.field).not.toBe(bare);
    });
  });

  describe('POST /auth/login', () => {
    const post = async (controller: LoginController, req: Request, body: Record<string, unknown>) => {
      const res = makeRes();
      await controller.handleLogin(req, body as any, res);
      return res;
    };
    const refused = (res: ReturnType<typeof makeRes>) => {
      expect(res._redirect).toBe(`/auth/login?error=${encodeURIComponent('Your session expired. Please try again.')}`);
      expect(res._cleared).toContain('login_csrf');
    };

    it('accepts the form of the pending authorization it was issued for', async () => {
      const { controller, social } = makeController();
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      const res = await post(
        controller,
        makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: form.cookie } }),
        { csrf: form.field, action: 'social:google' },
      );
      expect(social.start).toHaveBeenCalledTimes(1);
      expect(res._redirect).toBe('https://accounts.google.com/auth?x');
    });

    it('refuses the same form once the browser holds another pending authorization', async () => {
      const { controller, social, prisma } = makeController();
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      for (const action of ['social:google', 'approve-session', 'approve']) {
        refused(
          await post(
            controller,
            makeReq({ cookies: { oauth_session: 's2' }, signedCookies: { login_csrf: form.cookie } }),
            { csrf: form.field, action, email: 'a@b.com', password: 'pw' },
          ),
        );
      }
      expect(social.start).not.toHaveBeenCalled();
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('refuses it when the pending authorization is gone', async () => {
      const { controller, social } = makeController();
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      refused(
        await post(controller, makeReq({ signedCookies: { login_csrf: form.cookie } }), {
          csrf: form.field,
          action: 'social:google',
        }),
      );
      expect(social.start).not.toHaveBeenCalled();
    });

    it.each([
      ['another token', (f: { field: string; cookie: string }) => f.field.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))],
      ['the whole cookie value', (f: { field: string; cookie: string }) => f.cookie],
      ['the binding alone', (f: { field: string; cookie: string }) => f.cookie.split('.')[1]],
      ['nothing', () => ''],
      ['no string', () => ['x'] as unknown as string],
    ])('refuses a form that posts %s', async (_what, forge) => {
      const { controller, social } = makeController();
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      refused(
        await post(
          controller,
          makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: form.cookie } }),
          { csrf: forge(form), action: 'social:google' },
        ),
      );
      expect(social.start).not.toHaveBeenCalled();
    });

    it('refuses a cookie that carries a binding and no token', async () => {
      const { controller, social } = makeController();
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      const binding = form.cookie.split('.')[1];
      refused(
        await post(
          controller,
          makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: `.${binding}` } }),
          { csrf: '', action: 'social:google' },
        ),
      );
      expect(social.start).not.toHaveBeenCalled();
    });

    it('refuses a form without the cookie, whatever it posts', async () => {
      const { controller, social } = makeController();
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      refused(
        await post(controller, makeReq({ cookies: { oauth_session: 's1' } }), { csrf: form.field, action: 'social:google' }),
      );
      expect(social.start).not.toHaveBeenCalled();
    });

    it('keeps the form valid after a provider button: back from the provider, the second click still works', async () => {
      const { controller, social, sso } = makeController();
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      const req = () => makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: form.cookie } });

      const first = await post(controller, req(), { csrf: form.field, action: 'social:google' });
      expect(first._redirect).toBe('https://accounts.google.com/auth?x');
      expect(first._cleared).not.toContain('login_csrf');
      const second = await post(controller, req(), { csrf: form.field, action: 'social:google' });
      expect(second._redirect).toBe('https://accounts.google.com/auth?x');
      expect(social.start).toHaveBeenCalledTimes(2);

      const viaSso = await post(controller, req(), { csrf: form.field, action: 'sso:idp-1' });
      expect(viaSso._redirect).toBe('https://idp.example/authorize?x');
      expect(viaSso._cleared).not.toContain('login_csrf');
      expect(sso.startMcp).toHaveBeenCalledWith('idp-1', 's1');
    });

    it('still ends the token with the consent decision', async () => {
      const { controller, auth, prisma } = makeController(SELF_HOSTED);
      const form = await showForm(controller, makeReq({ cookies: { oauth_session: 's1' } }));
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'a@b.com', name: 'A', passwordHash: 'hash', emailVerified: true },
      ]);
      auth.comparePassword.mockResolvedValue(true);
      const res = await post(
        controller,
        makeReq({
          headers: { host: 'mcp.test' },
          cookies: { oauth_session: 's1' },
          signedCookies: { login_csrf: form.cookie },
        }),
        { csrf: form.field, action: 'approve', email: 'a@b.com', password: 'pw' },
      );
      expect(res._cookies.login_user).toBeDefined();
      expect(res._cleared).toContain('login_csrf');
      // Denying ends it too.
      const denied = await post(
        controller,
        makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: form.cookie } }),
        { csrf: form.field, action: 'deny' },
      );
      expect(denied._cleared).toEqual(expect.arrayContaining(['login_csrf', 'oauth_session', 'oauth_state']));
    });

    it('goes on accepting a cookie issued before the binding existed', async () => {
      const { controller, social } = makeController();
      const res = await post(
        controller,
        makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: 'tok' } }),
        { csrf: 'tok', action: 'social:google' },
      );
      expect(social.start).toHaveBeenCalledTimes(1);
      expect(res._redirect).toBe('https://accounts.google.com/auth?x');
    });
  });
});
