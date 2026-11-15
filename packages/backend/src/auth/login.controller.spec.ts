import { Logger } from '@nestjs/common';
// `openid-client` is ESM-only and this suite reaches it transitively through
// LoginController -> SsoService. Nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';
import { TELEGRAM_ONE_TAP } from '../adapters/telegram-managed-bot';
import { TELEGRAM_PANEL_SCRIPT } from './first-app-telegram';
import type { SsoService } from '../identity-providers/sso.service';
import type { Request, Response } from 'express';
import type { AuthService } from './auth.service';
import type { PrismaService } from '../common/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaOAuthStore } from './prisma-oauth.store';

interface FakeRes extends Response {
  _cookies: Record<string, { value: string; options: any }>;
  _cleared: string[];
  _headers: Record<string, string>;
  _sent?: string;
  _json?: any;
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
    json(payload: unknown) {
      this._json = payload;
      return this;
    },
    redirect(url: string) {
      this._redirect = url;
      return this;
    },
  };
  return res as FakeRes;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    cookies: {},
    signedCookies: {},
    secure: false,
    ...overrides,
  } as unknown as Request;
}

describe('LoginController', () => {
  let controller: LoginController;
  let authService: jest.Mocked<Pick<AuthService, 'comparePassword' | 'verifyToken'>>;
  let prisma: { user: { findUnique: jest.Mock; findMany: jest.Mock } };
  let config: jest.Mocked<Pick<ConfigService, 'get'>>;
  let store: jest.Mocked<
    Pick<PrismaOAuthStore, 'getOAuthSession' | 'getClient'>
  >;

  let sso: { startMcp: jest.Mock };
  let grants: {
    grantServers: jest.Mock;
    grantWholeOrganization: jest.Mock;
    listSelectableTargets: jest.Mock;
    resolve: jest.Mock;
  };

  beforeEach(() => {
    authService = {
      comparePassword: jest.fn(),
      verifyToken: jest.fn((_token: string): any => {
        throw new Error('invalid');
      }),
    };
    prisma = { user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } };
    config = { get: jest.fn().mockReturnValue(undefined) };
    store = { getOAuthSession: jest.fn(), getClient: jest.fn() };
    sso = { startMcp: jest.fn() };
    grants = {
      grantServers: jest.fn().mockResolvedValue([]),
      grantWholeOrganization: jest.fn().mockResolvedValue(true),
      listSelectableTargets: jest.fn().mockResolvedValue([]),
      // No grant: the user's own organization, as before grants existed.
      resolve: jest.fn().mockResolvedValue(null),
    };

    controller = new LoginController(
      authService as unknown as AuthService,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      store as unknown as PrismaOAuthStore,
      sso as unknown as SsoService,
      { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true } as any,
      grants as any,
    );
  });

  describe('GET /auth/login (consent + CSRF)', () => {
    it('renders the client name and redirect host for a pending OAuth session', async () => {
      store.getOAuthSession.mockResolvedValue({
        sessionId: 's1',
        state: 'x',
        clientId: 'client-abc',
        redirectUri: 'https://evil.example.com/callback',
        expiresAt: Date.now() + 60_000,
      } as any);
      store.getClient.mockResolvedValue({
        client_id: 'client-abc',
        client_name: 'Totally Legit App',
        redirect_uris: ['https://evil.example.com/callback'],
      } as any);

      const res = makeRes();
      await controller.showLoginPage(
        undefined as unknown as string,
        undefined as unknown as string,
        makeReq({ cookies: { oauth_session: 's1' } }),
        res,
      );

      expect(res._sent).toContain('Totally Legit App');
      expect(res._sent).toContain('evil.example.com');
      // A signed CSRF cookie is issued and mirrored into the form.
      const csrf = res._cookies['login_csrf'];
      expect(csrf).toBeDefined();
      expect(csrf.options.signed).toBe(true);
      expect(csrf.options.httpOnly).toBe(true);
      expect(res._sent).toContain(`name="csrf" value="${csrf.value}"`);
    });

    it('renders the provider mark unescaped and the provider name escaped', async () => {
      // Locks the new markup and the escaping invariant together: the SVG
      // must reach the page intact, the admin-supplied name must not.
      (prisma as any).mcpServerConfig = {
        findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
      };
      (prisma as any).identityProvider = {
        findMany: jest.fn().mockResolvedValue([
          { id: 'idp-1', name: '<script>x</script>', type: 'ENTRA' },
        ]),
      };

      const res = makeRes();
      await controller.showLoginPage(
        undefined as unknown as string,
        undefined as unknown as string,
        makeReq({ cookies: {}, signedCookies: { mcp_resource: 'srv-1' } } as any),
        res,
      );

      expect(res._sent).toContain('value="sso:idp-1"');
      // The Microsoft mark, unmodified: all four official colours present.
      expect(res._sent).toContain('class="sso-mark"');
      for (const colour of ['#F25022', '#7FBA00', '#00A4EF', '#FFB900']) {
        expect(res._sent).toContain(colour);
      }
      expect(res._sent).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(res._sent).not.toContain('<script>x</script>');
    });

    it('offers sign-up on cloud, returning to this page after verification', async () => {
      const cloud = new LoginController(
        authService as unknown as AuthService,
        prisma as unknown as PrismaService,
        config as unknown as ConfigService,
        store as unknown as PrismaOAuthStore,
        sso as unknown as SsoService,
        { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false } as any,
        grants as any,
      );
      const res = makeRes();
      await cloud.showLoginPage(
        undefined as unknown as string,
        undefined as unknown as string,
        makeReq({ cookies: {} }),
        res,
      );
      expect(res._sent).toContain('href="/login?mode=register&amp;redirect=%2Fauth%2Flogin"');
      expect(res._sent).toContain('href="/forgot-password"');
      // The sign-up is a button at the top of the card, before the form.
      expect(res._sent).toContain('class="signup-btn"');
      const html = res._sent ?? '';
      expect(html.indexOf('class="signup-btn"')).toBeLessThan(html.indexOf('id="email"'));
    });

    it('keeps only the small sign-up link after a failed sign-in', async () => {
      const cloud = new LoginController(
        authService as unknown as AuthService,
        prisma as unknown as PrismaService,
        config as unknown as ConfigService,
        store as unknown as PrismaOAuthStore,
        sso as unknown as SsoService,
        { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false } as any,
        grants as any,
      );
      const res = makeRes();
      await cloud.showLoginPage('Invalid email or password', undefined as unknown as string, makeReq({ cookies: {} }), res);
      expect(res._sent).not.toContain('class="signup-btn"');
      expect(res._sent).toContain('href="/login?mode=register&amp;redirect=%2Fauth%2Flogin"');
    });

    it('offers no sign-up on self-hosted (registration is invite-based there)', async () => {
      const res = makeRes();
      await controller.showLoginPage(
        undefined as unknown as string,
        undefined as unknown as string,
        makeReq({ cookies: {} }),
        res,
      );
      expect(res._sent).not.toContain('mode=register');
      expect(res._sent).toContain('href="/forgot-password"');
    });

    it('falls back to a generic form (no consent block) without a session', async () => {
      const res = makeRes();
      await controller.showLoginPage(
        undefined as unknown as string,
        undefined as unknown as string,
        makeReq({ cookies: {} }),
        res,
      );
      expect(store.getOAuthSession).not.toHaveBeenCalled();
      expect(res._sent).not.toContain('class="consent"');
      expect(res._cookies['login_csrf']).toBeDefined();
    });
  });

  describe('POST /auth/login (CSRF enforcement)', () => {
    it('rejects when the CSRF field does not match the signed cookie', async () => {
      const res = makeRes();
      await controller.handleLogin(
        makeReq({ signedCookies: { login_csrf: 'real-token' } }),
        { email: 'a@b.com', password: 'pw', csrf: 'forged-token' },
        res,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(res._redirect).toContain('/auth/login?error=');
      expect(res._cleared).toContain('login_csrf');
    });

    it('rejects when the CSRF cookie is missing entirely', async () => {
      const res = makeRes();
      await controller.handleLogin(
        makeReq({ signedCookies: {} }),
        { email: 'a@b.com', password: 'pw', csrf: 'anything' },
        res,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(res._redirect).toContain('/auth/login?error=');
    });
  });

  describe('POST /auth/login (deny)', () => {
    it('aborts the flow and drops OAuth cookies on explicit denial', async () => {
      const res = makeRes();
      await controller.handleLogin(
        makeReq({ signedCookies: { login_csrf: 'tok' } }),
        { email: '', password: '', csrf: 'tok', action: 'deny' },
        res,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(res._cleared).toEqual(
        expect.arrayContaining(['oauth_session', 'oauth_state', 'login_csrf']),
      );
      expect(res._sent).toContain('Request Cancelled');
    });
  });

  describe('POST /auth/login (credentials)', () => {
    const okReq = () =>
      makeReq({ signedCookies: { login_csrf: 'tok' }, headers: { host: 'mcp.test' } });

    it('sets login_user and redirects to /callback on valid credentials', async () => {
      prisma.user.findMany.mockResolvedValue([{
        id: 'u1',
        email: 'a@b.com',
        name: 'A',
        passwordHash: 'hash',
      }]);
      authService.comparePassword.mockResolvedValue(true);

      const res = makeRes();
      await controller.handleLogin(
        okReq(),
        { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' },
        res,
      );

      expect(res._cookies['login_user']).toBeDefined();
      expect(res._cookies['login_user'].options.signed).toBe(true);
      // Remembered for the setup links the AI client hands out next.
      expect(res._cookies['amcp_signin'].options).toEqual(
        expect.objectContaining({ httpOnly: true, signed: true, sameSite: 'lax' }),
      );
      expect(JSON.parse(Buffer.from(res._cookies['amcp_signin'].value, 'base64url').toString())).toEqual(
        expect.objectContaining({ uid: expect.any(String), iat: expect.any(Number) }),
      );
      expect(res._cleared).toContain('login_csrf');
      expect(res._redirect).toBe('http://mcp.test/callback');
    });

    it('signs in an account stored with capitals from the lower-case address', async () => {
      prisma.user.findMany.mockResolvedValue([{
        id: 'u1',
        email: 'Name@Example.com',
        name: 'A',
        passwordHash: 'hash',
      }]);
      authService.comparePassword.mockResolvedValue(true);

      const res = makeRes();
      await controller.handleLogin(
        okReq(),
        { email: 'name@example.com', password: 'pw', csrf: 'tok', action: 'approve' },
        res,
      );

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { email: { in: ['name@example.com'] } },
            { email: { equals: 'name@example.com', mode: 'insensitive' } },
          ],
        },
      });
      expect(authService.comparePassword).toHaveBeenCalledWith('pw', 'hash');
      const profile = JSON.parse(Buffer.from(res._cookies['login_user'].value, 'base64url').toString());
      expect(profile.id).toBe('u1');
      expect(res._redirect).toBe('http://mcp.test/callback');
    });

    it('redirects with an error on wrong password (no login_user set)', async () => {
      prisma.user.findMany.mockResolvedValue([{
        id: 'u1',
        email: 'a@b.com',
        passwordHash: 'hash',
      }]);
      authService.comparePassword.mockResolvedValue(false);

      const res = makeRes();
      await controller.handleLogin(
        okReq(),
        { email: 'a@b.com', password: 'bad', csrf: 'tok', action: 'approve' },
        res,
      );

      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._cookies['amcp_signin']).toBeUndefined();
      expect(res._redirect).toContain('/auth/login?error=');
    });

    it('logs the address masked on failed and successful logins', async () => {
      const lines: string[] = [];
      const spies = (['log', 'warn'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
          lines.push(String(message));
        }),
      );
      try {
        prisma.user.findMany.mockResolvedValue([]);
        await controller.handleLogin(
          okReq(),
          { email: 'ada.lovelace@example.com', password: 'pw', csrf: 'tok', action: 'approve' },
          makeRes(),
        );
        prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'ada.lovelace@example.com', passwordHash: 'hash' }]);
        authService.comparePassword.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        for (const password of ['bad', 'pw']) {
          await controller.handleLogin(
            okReq(),
            { email: 'ada.lovelace@example.com', password, csrf: 'tok', action: 'approve' },
            makeRes(),
          );
        }
        expect(lines.filter((line) => line.includes('ad***@example.com'))).toHaveLength(3);
        for (const line of lines) expect(line).not.toContain('ada.lovelace@');
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });
  });

  describe('already signed in to the dashboard', () => {
    const nowSec = () => Math.floor(Date.now() / 1000);
    const pendingSession = () => {
      store.getOAuthSession.mockResolvedValue({
        sessionId: 's1',
        state: 'x',
        clientId: 'client-abc',
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        expiresAt: Date.now() + 60_000,
      } as any);
      store.getClient.mockResolvedValue({ client_id: 'client-abc', client_name: 'Claude' } as any);
    };
    const validUser = (over: Record<string, unknown> = {}) => ({
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      emailVerified: true,
      sessionsValidFrom: null,
      memberships: [{ organizationId: 'org-1' }],
      ...over,
    });
    const dashboardToken = (over: Record<string, unknown> = {}) =>
      authService.verifyToken.mockReturnValue({
        sub: 'u1',
        email: 'a@b.com',
        role: 'ADMIN',
        organizationId: 'org-1',
        tokenUse: 'dashboard',
        iat: nowSec(),
        ...over,
      } as any);
    const getPage = async (cookies: Record<string, string>, switchAccount?: string) => {
      const res = makeRes();
      await controller.showLoginPage(
        undefined as unknown as string,
        switchAccount as unknown as string,
        makeReq({ cookies }),
        res,
      );
      return res;
    };

    it('offers Approve instead of the password form, and forbids framing', async () => {
      pendingSession();
      dashboardToken();
      prisma.user.findUnique.mockResolvedValue(validUser());

      const res = await getPage({ oauth_session: 's1', amcp_token: 'jwt' });

      expect(authService.verifyToken).toHaveBeenCalledWith('jwt');
      expect(res._sent).toContain('Signed in as <strong>a@b.com</strong>');
      expect(res._sent).toContain('value="approve-session"');
      // A way to sign in as someone else, keeping the pending authorization.
      expect(res._sent).toContain('href="/auth/login?switch=1">Switch account</a>');
      expect(res._sent).not.toContain('name="password"');
      expect(res._sent).toContain('Claude');
      expect(res._headers['Content-Security-Policy']).toBe("frame-ancestors 'none'");
    });

    it('shows the password form when the user asked to switch accounts', async () => {
      pendingSession();
      dashboardToken();
      prisma.user.findUnique.mockResolvedValue(validUser());

      const res = await getPage({ oauth_session: 's1', amcp_token: 'jwt' }, '1');

      expect(res._sent).toContain('name="password"');
      expect(res._sent).not.toContain('approve-session');
    });

    it('never offers Approve outside an authorize flow', async () => {
      dashboardToken();
      prisma.user.findUnique.mockResolvedValue(validUser());

      const res = await getPage({ amcp_token: 'jwt' });

      expect(authService.verifyToken).not.toHaveBeenCalled();
      expect(res._sent).toContain('name="password"');
    });

    it.each([
      ['an invalid or expired token', () => undefined, {}],
      ['an MCP-issued token', () => dashboardToken({ tokenUse: undefined, client_id: 'x' }), {}],
      ['a token without the dashboard marker', () => dashboardToken({ tokenUse: undefined }), {}],
      [
        'a revoked session',
        () => dashboardToken({ iat: nowSec() - 3600 }),
        { sessionsValidFrom: new Date() },
      ],
      ['a user with no active workspace', () => dashboardToken(), { memberships: [] }],
    ])('falls back to the password form for %s', async (_label, arrange, userOver) => {
      pendingSession();
      arrange();
      prisma.user.findUnique.mockResolvedValue(validUser(userOver));

      const res = await getPage({ oauth_session: 's1', amcp_token: 'jwt' });

      expect(res._sent).toContain('name="password"');
      expect(res._sent).not.toContain('approve-session');
    });

    it('falls back when the user no longer exists', async () => {
      pendingSession();
      dashboardToken();
      prisma.user.findUnique.mockResolvedValue(null);

      const res = await getPage({ oauth_session: 's1', amcp_token: 'jwt' });

      expect(res._sent).toContain('name="password"');
    });

    it('approve-session sets login_user from the session and continues to /callback', async () => {
      pendingSession();
      dashboardToken();
      prisma.user.findUnique.mockResolvedValue(validUser());

      const res = makeRes();
      await controller.handleLogin(
        makeReq({
          cookies: { oauth_session: 's1', amcp_token: 'jwt' },
          signedCookies: { login_csrf: 'tok' },
          headers: { host: 'mcp.test' },
        } as any),
        // A forged email in the body must be ignored.
        { email: 'victim@x.com', password: '', csrf: 'tok', action: 'approve-session' },
        res,
      );

      const profile = JSON.parse(
        Buffer.from(res._cookies['login_user'].value, 'base64url').toString(),
      );
      expect(profile).toMatchObject({ id: 'u1', email: 'a@b.com' });
      expect(res._cookies['login_user'].options.signed).toBe(true);
      expect(authService.comparePassword).not.toHaveBeenCalled();
      expect(res._redirect).toBe('http://mcp.test/callback');
    });

    it('approve-session without a valid session sets nothing and asks to sign in', async () => {
      pendingSession();
      prisma.user.findUnique.mockResolvedValue(validUser());

      const res = makeRes();
      await controller.handleLogin(
        makeReq({
          cookies: { oauth_session: 's1', amcp_token: 'forged' },
          signedCookies: { login_csrf: 'tok' },
        } as any),
        { email: '', password: '', csrf: 'tok', action: 'approve-session' },
        res,
      );

      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._redirect).toContain('/auth/login?switch=1&error=');
    });

    it('approve-session is refused without a matching CSRF token', async () => {
      pendingSession();
      dashboardToken();
      prisma.user.findUnique.mockResolvedValue(validUser());

      const res = makeRes();
      await controller.handleLogin(
        makeReq({
          cookies: { oauth_session: 's1', amcp_token: 'jwt' },
          signedCookies: { login_csrf: 'tok' },
        } as any),
        { email: '', password: '', csrf: 'other', action: 'approve-session' },
        res,
      );

      expect(res._cookies['login_user']).toBeUndefined();
      expect(authService.verifyToken).not.toHaveBeenCalled();
    });

    it('approve-session outside an authorize flow is refused', async () => {
      dashboardToken();
      prisma.user.findUnique.mockResolvedValue(validUser());

      const res = makeRes();
      await controller.handleLogin(
        makeReq({
          cookies: { amcp_token: 'jwt' },
          signedCookies: { login_csrf: 'tok' },
        } as any),
        { email: '', password: '', csrf: 'tok', action: 'approve-session' },
        res,
      );

      expect(res._cookies['login_user']).toBeUndefined();
    });
  });

  describe('cloud: approving into an empty workspace', () => {
    let cloud: LoginController;
    let productEvents: { log: jest.Mock };
    let licenseGuard: { getTrialState: jest.Mock };
    let eligibility: { hadSubscription: jest.Mock };
    let cloudPrisma: {
      user: { findUnique: jest.Mock; findMany: jest.Mock };
      organizationMember: { findFirst: jest.Mock };
      connector: { count: jest.Mock };
    };

    const arrange = (
      opts: { connectors?: number; role?: string; session?: boolean; sessionLeftMs?: number } = {},
    ) => {
      if (opts.session !== false) {
        store.getOAuthSession.mockResolvedValue({
          sessionId: 's1',
          state: 'x',
          clientId: 'client-abc',
          redirectUri: 'https://claude.ai/api/mcp/auth_callback',
          expiresAt: Date.now() + (opts.sessionLeftMs ?? 20 * 60_000),
        } as any);
        store.getClient.mockResolvedValue({ client_id: 'client-abc', client_name: 'Claude' } as any);
      }
      cloudPrisma.user.findUnique.mockImplementation(({ select }: any) =>
        select?.organizationId
          ? { organizationId: 'org-1', email: 'a@b.com' }
          : { id: 'u1', email: 'a@b.com', name: 'A', passwordHash: 'hash', emailVerified: true },
      );
      cloudPrisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@b.com', name: 'A', passwordHash: 'hash', emailVerified: true }]);
      cloudPrisma.organizationMember.findFirst.mockResolvedValue({ role: opts.role ?? 'ADMIN' });
      cloudPrisma.connector.count.mockResolvedValue(opts.connectors ?? 0);
      authService.comparePassword.mockResolvedValue(true);
    };

    const login = async (signedCookies: Record<string, string> = {}) => {
      const res = makeRes();
      await cloud.handleLogin(
        makeReq({
          cookies: { oauth_session: 's1' },
          signedCookies: { login_csrf: 'tok', ...signedCookies },
          headers: { host: 'mcp.test' },
        } as any),
        { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' },
        res,
      );
      return res;
    };

    beforeEach(() => {
      cloudPrisma = {
        user: { findUnique: jest.fn(), findMany: jest.fn() },
        organizationMember: { findFirst: jest.fn() },
        connector: { count: jest.fn() },
      };
      productEvents = { log: jest.fn().mockResolvedValue(undefined) };
      licenseGuard = { getTrialState: jest.fn().mockResolvedValue(null) };
      eligibility = { hadSubscription: jest.fn().mockResolvedValue(false) };
      config.get.mockImplementation((key: string) =>
        key === 'FRONTEND_URL' ? 'https://cloud.example/' : undefined,
      );
      cloud = new LoginController(
        authService as unknown as AuthService,
        cloudPrisma as unknown as PrismaService,
        config as unknown as ConfigService,
        store as unknown as PrismaOAuthStore,
        sso as unknown as SsoService,
        { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false } as any,
        grants as any,
        productEvents as any,
        licenseGuard as any,
        eligibility as any,
      );
    });

    // The funnel before sign-up: a view inside a pending authorization is
    // recorded once per attempt, with the client and the kind of device.
    it('records that the sign-in page was opened inside an authorization', async () => {
      arrange();
      productEvents.log.mockClear();
      const view = (userAgent: string, cookies: Record<string, string> = { oauth_session: 's1' }) =>
        cloud.showLoginPage(
          undefined as unknown as string,
          undefined as unknown as string,
          makeReq({ cookies, headers: { host: 'mcp.test', 'user-agent': userAgent } } as any),
          makeRes(),
        );
      await view('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
      await view('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36');
      const views = productEvents.log.mock.calls.map((c) => c[0]).filter((e) => e.event === 'authorize_page_viewed');
      expect(views).toHaveLength(2);
      expect(views[0].metadata).toEqual({ client: 'Claude', device: 'mobile', attempt: expect.stringMatching(/^[0-9a-z]{6,12}$/) });
      expect(views[1].metadata.device).toBe('desktop');
      // The same authorization: the same value, so a reload counts once.
      expect(views[1].metadata.attempt).toBe(views[0].metadata.attempt);
      // Nothing of the session id.
      expect(JSON.stringify(views)).not.toContain('"s1"');
      expect(views[0].userId).toBeUndefined();
    });

    it('records nothing for a page opened outside an authorization', async () => {
      arrange({ session: false });
      productEvents.log.mockClear();
      await cloud.showLoginPage(
        undefined as unknown as string,
        undefined as unknown as string,
        makeReq({ cookies: {}, headers: { host: 'mcp.test' } } as any),
        makeRes(),
      );
      expect(productEvents.log.mock.calls.map((c) => c[0].event)).not.toContain('authorize_page_viewed');
    });

    it('explains how to add an app before handing back to the client', async () => {
      arrange();
      const res = await login();

      expect(res._redirect).toBeUndefined();
      expect(res._sent).toContain('Claude is connected');
      expect(res._sent).toContain('href="http://mcp.test/callback"');
      expect(res._sent).toContain('href="https://cloud.example/welcome"');
      expect(res._sent).toContain('target="_blank"');
      // A detour keeps "Continue" working as long as the authorization lives.
      const maxAge = res._cookies['login_user'].options.maxAge;
      expect(maxAge).toBeGreaterThan(19 * 60 * 1000);
      expect(maxAge).toBeLessThanOrEqual(20 * 60 * 1000);
      expect(res._cookies['login_user'].options.signed).toBe(true);
      expect(productEvents.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'empty_workspace_prompt',
          userId: 'u1',
          organizationId: 'org-1',
        }),
      );
    });

    it('offers to copy the example request, without its quotes', async () => {
      arrange();
      const page = (await login())._sent as string;

      expect(page).toContain('<span id="example-request">Connect my Telegram bot to AnythingMCP.</span>');
      expect(page).toContain('<button type="button" class="copy" id="copy-request">Copy</button>');
      // The button sits inside the example, never in the form that continues the authorization.
      expect(page).toContain("navigator.clipboard.writeText(request.textContent || '')");
      expect(page.indexOf('id="copy-request"')).toBeLessThan(page.indexOf('Continue to Claude'));
    });

    it('never keeps the login cookie past 30 minutes, nor under one', async () => {
      arrange({ sessionLeftMs: 2 * 60 * 60_000 });
      expect((await login())._cookies['login_user'].options.maxAge).toBe(30 * 60 * 1000);
      arrange({ sessionLeftMs: 5_000 });
      expect((await login())._cookies['login_user'].options.maxAge).toBe(60 * 1000);
    });

    describe('the card-trial line', () => {
      const DAY = 86_400_000;
      const trial = (over: Record<string, unknown> = {}) => ({
        endsAt: new Date('2026-10-13T09:30:00Z'),
        active: true,
        cardTrialAvailable: true,
        ...over,
      });

      it('tells an admin on the free trial when it ends, under Continue, in a new tab', async () => {
        arrange();
        licenseGuard.getTrialState.mockResolvedValue(trial());
        const res = await login();

        expect(licenseGuard.getTrialState).toHaveBeenCalledWith('org-1');
        expect(res._sent).toContain('Your free trial runs until October&nbsp;13.');
        expect(res._sent).toContain('Nothing is charged before October&nbsp;13.');
        expect(res._sent).toMatch(
          /<a href="https:\/\/cloud\.example\/start-trial\?source=post_approve" target="_blank" rel="noopener noreferrer">add a payment method now \(new tab\)<\/a>/,
        );
        // Continue stays the first and only button.
        const html = res._sent ?? '';
        expect(html.indexOf('Continue to Claude')).toBeLessThan(html.indexOf('start-trial'));
        expect(html.match(/class="button"/g)).toHaveLength(1);
        expect(productEvents.log).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'empty_workspace_prompt',
            metadata: { client: 'Claude', cardTrialOffered: true },
          }),
        );
      });

      it.each([
        ['less than 48 hours are left', trial({ cardTrialAvailable: false, endsAt: new Date(Date.now() + DAY) })],
        ['the trial has ended', trial({ active: false, cardTrialAvailable: false })],
        ['the workspace is on a paid plan', null],
      ])('is left out when %s', async (_label, state) => {
        arrange();
        licenseGuard.getTrialState.mockResolvedValue(state);
        const res = await login();

        expect(res._sent).toContain('Claude is connected');
        expect(res._sent).not.toContain('start-trial');
        expect(productEvents.log).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: { client: 'Claude' } }),
        );
      });

      it('is left out for an address that had a subscription: it would pay today', async () => {
        arrange();
        licenseGuard.getTrialState.mockResolvedValue(trial());
        eligibility.hadSubscription.mockResolvedValue(true);
        const res = await login();

        expect(eligibility.hadSubscription).toHaveBeenCalledWith('a@b.com');
        expect(res._sent).toContain('Claude is connected');
        expect(res._sent).not.toContain('start-trial');
        expect(res._sent).not.toContain('Nothing is charged');
      });

      it('keeps the line when the history is unknown, and never waits long for it', async () => {
        arrange();
        licenseGuard.getTrialState.mockResolvedValue(trial());
        eligibility.hadSubscription.mockReturnValue(new Promise(() => undefined));
        const started = Date.now();
        const res = await login();

        expect(Date.now() - started).toBeLessThan(3000);
        expect(res._sent).toContain('start-trial');
      });

      it('is never shown to an editor, whose licence is not looked up', async () => {
        arrange({ role: 'EDITOR' });
        licenseGuard.getTrialState.mockResolvedValue(trial());
        const res = await login();

        expect(res._sent).toContain('Claude is connected');
        expect(res._sent).not.toContain('start-trial');
        expect(licenseGuard.getTrialState).not.toHaveBeenCalled();
      });

      it('never costs the connection when the licence cannot be read', async () => {
        arrange();
        licenseGuard.getTrialState.mockRejectedValue(new Error('db down'));
        const res = await login();

        expect(res._sent).toContain('href="http://mcp.test/callback"');
        expect(res._sent).not.toContain('start-trial');
      });
    });

    it('escapes the client name the client registered itself', async () => {
      arrange();
      store.getClient.mockResolvedValue({ client_id: 'c', client_name: '<img src=x>' } as any);
      const res = await login();

      expect(res._sent).toContain('&lt;img src=x&gt; is connected');
      expect(res._sent).not.toContain('<img src=x>');
    });

    it.each([
      ['the workspace has connectors', { connectors: 2 }],
      ['the user cannot add connectors', { role: 'VIEWER' }],
    ])('goes straight to /callback when %s', async (_label, opts) => {
      arrange(opts);
      const res = await login();

      expect(res._redirect).toBe('http://mcp.test/callback');
      expect(res._cookies['login_user'].options.maxAge).toBe(60 * 1000);
      expect(productEvents.log).not.toHaveBeenCalled();
    });

    it('goes straight to /callback when the client connects one server URL', async () => {
      arrange();
      const res = await login({ mcp_resource: 'srv-1' });

      expect(res._redirect).toBe('http://mcp.test/callback');
    });

    it('never shows on self-hosted', async () => {
      arrange();
      const selfHosted = new LoginController(
        authService as unknown as AuthService,
        cloudPrisma as unknown as PrismaService,
        config as unknown as ConfigService,
        store as unknown as PrismaOAuthStore,
        sso as unknown as SsoService,
        { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true } as any,
        grants as any,
        productEvents as any,
      );
      const res = makeRes();
      await selfHosted.handleLogin(
        makeReq({
          cookies: { oauth_session: 's1' },
          signedCookies: { login_csrf: 'tok' },
          headers: { host: 'mcp.test' },
        } as any),
        { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' },
        res,
      );

      expect(res._redirect).toBe('http://mcp.test/callback');
      expect(cloudPrisma.connector.count).not.toHaveBeenCalled();
    });

    describe('a user in several workspaces', () => {
      // org-1 is the user's primary workspace and has connectors; org-2 is
      // another workspace of theirs, empty, where they are an admin.
      const arrangeWorkspaces = (roles: Record<string, string> = { 'org-1': 'ADMIN', 'org-2': 'ADMIN' }) => {
        arrange();
        cloudPrisma.organizationMember.findFirst.mockImplementation(({ where }: any) =>
          roles[where.organizationId] ? { role: roles[where.organizationId] } : null,
        );
        cloudPrisma.connector.count.mockImplementation(({ where }: any) => (where.organizationId === 'org-1' ? 3 : 0));
      };

      const choose = async (body: Record<string, unknown>, c: LoginController = cloud, signed: Record<string, string> = {}) => {
        const res = makeRes();
        await c.handleServerSelection(
          makeReq({
            cookies: { oauth_session: 's1' },
            signedCookies: { login_csrf: 'tok', pending_grant: 'u1', ...signed },
            headers: { host: 'mcp.test' },
          } as any),
          { csrf: 'tok', ...body } as any,
          res,
        );
        return res;
      };

      it('offers the first app for an empty workspace picked on "Choose what to connect"', async () => {
        arrangeWorkspaces();
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
        const res = await choose({ workspace: 'org-2' });

        expect(grants.grantWholeOrganization).toHaveBeenCalledWith('client-abc', 'u1', 'org-2');
        expect(res._redirect).toBeUndefined();
        expect(res._sent).toContain('Claude is connected');
        expect(res._sent).toContain('href="http://mcp.test/callback"');
        expect(cloudPrisma.connector.count).toHaveBeenCalledWith({ where: { organizationId: 'org-2' } });
        expect(res._cookies['login_user'].options.maxAge).toBeGreaterThan(60 * 1000);
        expect(res._cleared).toEqual(expect.arrayContaining(['login_csrf', 'pending_grant']));
        expect(productEvents.log).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'empty_workspace_prompt', organizationId: 'org-2' }),
        );
      });

      it('offers it too for servers picked in an empty workspace', async () => {
        arrangeWorkspaces();
        grants.grantServers.mockResolvedValue(['srv-2']);
        grants.resolve.mockResolvedValue({ mode: 'servers', servers: [{ id: 'srv-2', organizationId: 'org-2' }] });
        const res = await choose({ servers: 'srv-2' });

        expect(res._sent).toContain('Claude is connected');
        expect(cloudPrisma.connector.count).toHaveBeenCalledWith({ where: { organizationId: 'org-2' } });
      });

      it('goes straight to /callback for a workspace that has connectors', async () => {
        arrangeWorkspaces();
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-1' });
        const res = await choose({ workspace: 'org-1' });

        expect(res._redirect).toBe('http://mcp.test/callback');
        expect(res._sent).toBeUndefined();
        expect(productEvents.log).not.toHaveBeenCalled();
      });

      it('goes straight to /callback for an empty workspace where the user is a viewer', async () => {
        arrangeWorkspaces({ 'org-1': 'ADMIN', 'org-2': 'VIEWER' });
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
        const res = await choose({ workspace: 'org-2' });

        expect(res._redirect).toBe('http://mcp.test/callback');
      });

      it('goes straight to /callback for servers in more than one workspace', async () => {
        arrangeWorkspaces();
        grants.grantServers.mockResolvedValue(['srv-1', 'srv-2']);
        grants.resolve.mockResolvedValue({
          mode: 'servers',
          servers: [
            { id: 'srv-1', organizationId: 'org-1' },
            { id: 'srv-2', organizationId: 'org-2' },
          ],
        });
        const res = await choose({ servers: ['srv-1', 'srv-2'] });

        expect(res._redirect).toBe('http://mcp.test/callback');
        expect(cloudPrisma.connector.count).not.toHaveBeenCalled();
      });

      it('never offers it on self-hosted', async () => {
        arrangeWorkspaces();
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
        const selfHosted = new LoginController(
          authService as unknown as AuthService,
          cloudPrisma as unknown as PrismaService,
          config as unknown as ConfigService,
          store as unknown as PrismaOAuthStore,
          sso as unknown as SsoService,
          { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true } as any,
          grants as any,
          productEvents as any,
        );
        const res = await choose({ workspace: 'org-2' }, selfHosted);

        expect(res._redirect).toBe('http://mcp.test/callback');
        expect(cloudPrisma.connector.count).not.toHaveBeenCalled();
      });

      it('counts the granted workspace, not the primary one, on sign-in too', async () => {
        arrangeWorkspaces();
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
        const res = await login();

        expect(res._sent).toContain('Claude is connected');
        expect(cloudPrisma.connector.count).toHaveBeenCalledWith({ where: { organizationId: 'org-2' } });
        expect(cloudPrisma.connector.count).not.toHaveBeenCalledWith({ where: { organizationId: 'org-1' } });
      });

      it('carries a social sign-in across the picker to the dashboard links', async () => {
        arrangeWorkspaces();
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
        const social = { enabledProviders: () => [{ id: 'google', name: 'Google' }] };
        const withSocial = new LoginController(
          authService as unknown as AuthService,
          cloudPrisma as unknown as PrismaService,
          config as unknown as ConfigService,
          store as unknown as PrismaOAuthStore,
          sso as unknown as SsoService,
          { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false } as any,
          grants as any,
          productEvents as any,
          licenseGuard as any,
          eligibility as any,
          social as any,
        );
        // Signing in with Google lands on the picker, which keeps the provider.
        grants.listSelectableTargets.mockResolvedValue([
          { organizationId: 'org-1', organizationName: 'Primary', servers: [{ id: 'srv-1', name: 'A', connectorCount: 3 }] },
          { organizationId: 'org-2', organizationName: 'Other', servers: [{ id: 'srv-2', name: 'B', connectorCount: 0 }] },
        ]);
        const picker = makeRes();
        await (withSocial as any).completeSignIn(
          makeReq({ cookies: { oauth_session: 's1' }, headers: { host: 'mcp.test' } } as any),
          picker,
          { id: 'u1', email: 'a@b.com', name: 'A' },
          'google',
        );
        expect(picker._sent).toContain('Choose what to connect');
        expect(picker._cookies['pending_grant_social']).toEqual({
          value: 'google',
          options: expect.objectContaining({ httpOnly: true, signed: true }),
        });

        const res = await choose({ workspace: 'org-2' }, withSocial, { pending_grant_social: 'google' });
        expect(res._sent).toContain(
          `href="https://cloud.example/login?continueWith=google&amp;redirect=${encodeURIComponent('/welcome')}"`,
        );
        expect(res._cleared).toContain('pending_grant_social');
      });

      it('ignores a provider this deployment does not offer', async () => {
        arrangeWorkspaces();
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
        const res = await choose({ workspace: 'org-2' }, cloud, { pending_grant_social: 'evil' });

        expect(res._sent).toContain('href="https://cloud.example/welcome"');
        expect(res._sent).not.toContain('continueWith');
      });
    });

    describe('the optional app picker', () => {
      let provider: { canSetUp: jest.Mock; install: jest.Mock; find: jest.Mock; status: jest.Mock };
      let picking: LoginController;
      const LOGIN_USER = Buffer.from(JSON.stringify({ id: 'u1', email: 'a@b.com' })).toString('base64url');

      const make = (deployment: object, withProvider = true) =>
        new LoginController(
          authService as unknown as AuthService,
          cloudPrisma as unknown as PrismaService,
          config as unknown as ConfigService,
          store as unknown as PrismaOAuthStore,
          sso as unknown as SsoService,
          deployment as any,
          grants as any,
          productEvents as any,
          licenseGuard as any,
          eligibility as any,
          undefined,
          { get: () => ({ get: () => (withProvider ? provider : null) }) } as any,
        );
      const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };

      beforeEach(() => {
        provider = {
          canSetUp: jest.fn().mockResolvedValue(true),
          install: jest.fn().mockResolvedValue({ body: { installed: 'Telegram Bot', status: 'needs_input', finishSetupUrl: 'https://cloud.example/s/x' } }),
          find: jest.fn(),
          status: jest.fn(),
        };
        grants.resolve.mockResolvedValue({ mode: 'servers', servers: [{ id: 'srv-1', organizationId: 'org-1' }] });
        picking = make(CLOUD);
      });

      const showPage = async (c: LoginController = picking, userAgent?: string) => {
        const res = makeRes();
        await c.handleLogin(
          makeReq({
            cookies: { oauth_session: 's1' },
            signedCookies: { login_csrf: 'tok' },
            headers: { host: 'mcp.test', ...(userAgent ? { 'user-agent': userAgent } : {}) },
          } as any),
          { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' },
          res,
        );
        return res;
      };

      const pick = async (
        body: Record<string, unknown>,
        signedCookies: Record<string, string> = { first_app_csrf: 'pick-tok', login_user: LOGIN_USER },
        c: LoginController = picking,
      ) => {
        const res = makeRes();
        await c.pickFirstApp(
          makeReq({ cookies: { oauth_session: 's1' }, signedCookies, headers: { host: 'mcp.test' } } as any),
          body,
          res,
        );
        return res;
      };

      it('is offered, hidden until its script runs, with its own CSRF cookie', async () => {
        arrange();
        const res = await showPage();
        const page = res._sent as string;
        const token = res._cookies['first_app_csrf'];

        expect(token.options).toEqual(expect.objectContaining({ httpOnly: true, signed: true }));
        expect(token.options.maxAge).toBe(res._cookies['login_user'].options.maxAge);
        expect(page).toContain(`<section class="quick" id="quick-apps" hidden data-csrf="${token.value}"`);
        for (const [slug, name] of [
          ['etsy', 'Etsy'],
          ['telegram-bot', 'Telegram'],
          ['woocommerce', 'WooCommerce'],
          ['odoo', 'Odoo'],
          ['printify', 'Printify'],
        ]) {
          expect(page).toContain(`data-adapter="${slug}" data-name="${name}">${name}</button>`);
        }
        // Picked often, set up almost never: it is reached through "Another app".
        expect(page).not.toContain('data-adapter="gemini"');
        // Needs the store owner and an app in Shopify's Dev Dashboard: 75 picks, no keys.
        expect(page).not.toContain('data-adapter="shopify"');
        expect(page).toContain('<label class="other-label" for="other-app">Another app</label>');
        expect(page).toContain('role="status" aria-live="polite"');
        // Optional: Continue is still the one button, straight to the callback.
        expect(page.match(/class="button"/g)).toHaveLength(1);
        expect(page).toContain('href="http://mcp.test/callback" data-open-chat="https://claude.ai/new"');
        expect(page.indexOf('id="quick-apps"')).toBeLessThan(page.indexOf('Continue to Claude'));
      });

      describe('its script', () => {
        type El = {
          textContent: string;
          hidden: boolean;
          disabled: boolean;
          value: string;
          attrs: Record<string, string>;
          listeners: Record<string, (e: unknown) => void>;
          getAttribute(n: string): string | null;
          setAttribute(n: string, v: string): void;
          addEventListener(t: string, f: (e: unknown) => void): void;
          querySelectorAll(): El[];
        };
        const el = (attrs: Record<string, string> = {}, text = ''): El => ({
          textContent: text,
          hidden: false,
          disabled: false,
          value: '',
          attrs,
          listeners: {},
          getAttribute(n) {
            return n in this.attrs ? this.attrs[n] : null;
          },
          setAttribute(n, v) {
            this.attrs[n] = v;
          },
          addEventListener(t, f) {
            this.listeners[t] = f;
          },
          querySelectorAll() {
            return [];
          },
        });
        const flush = () => new Promise((r) => setImmediate(r));

        /** Runs the page's scripts against a minimal DOM built from the page. */
        const run = async (
          fetchAnswer: () => Promise<unknown>,
          touch = false,
          opts: { userAgent?: string; navigator?: object; client?: string } = {},
        ) => {
          arrange();
          const page = (await showPage(picking, opts.userAgent))._sent as string;
          const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
          const chips = [...page.matchAll(/data-adapter="([^"]+)" data-name="([^"]+)"/g)].map((m) =>
            el({ 'data-adapter': m[1], 'data-name': m[2], 'aria-pressed': 'false' }),
          );
          const picker = el({ 'data-csrf': /data-csrf="([^"]+)"/.exec(page)![1] });
          picker.hidden = true;
          picker.querySelectorAll = () => chips;
          const nodes: Record<string, El> = {
            'copy-request': el(),
            'example-request': el({}, 'Connect my Telegram bot to AnythingMCP.'),
            'quick-apps': picker,
            'quick-status': el(),
            'other-app': el(),
            // Continue and the "Copied" line as the page really has them.
            continue: el({
              'data-client': 'Claude',
              ...(/id="continue"[^>]*data-open-chat=/.test(page) ? { 'data-open-chat': 'https://claude.ai/new' } : {}),
            }),
            'request-copied': el(/id="request-copied"[^>]*data-phone="1"/.test(page) ? { 'data-phone': '1' } : {}),
          };
          nodes['request-copied'].hidden = /id="request-copied"[^>]*\shidden/.test(page);
          const fetch = jest.fn(async () => ({ json: async () => fetchAnswer() }));
          const open = jest.fn();
          const window = { fetch, JSON, open, matchMedia: (q: string) => ({ matches: touch && q === '(pointer: coarse)' }) };
          require('vm').runInNewContext(script, {
            document: { getElementById: (id: string) => nodes[id] ?? null },
            navigator: opts.navigator ?? {},
            window,
            fetch,
            JSON,
            encodeURIComponent,
          });
          return { nodes, chips, fetch, open, page };
        };

        it('shows the picker, adds a picked app and changes the request', async () => {
          const { nodes, chips, fetch } = await run(async () => ({
            ok: true,
            name: 'Telegram',
            request: 'Finish setting up my Telegram connector.',
          }));
          expect(nodes['quick-apps'].hidden).toBe(false);
          chips[1].listeners.click({ currentTarget: chips[1] });
          await flush();
          await flush();

          expect(fetch).toHaveBeenCalledWith('/auth/first-app', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
          expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({
            adapter: 'telegram-bot',
            csrf: nodes['quick-apps'].attrs['data-csrf'],
          });
          expect(nodes['example-request'].textContent).toBe('Finish setting up my Telegram connector.');
          expect(nodes['quick-status'].textContent).toBe('Telegram added — you’ll finish it in Claude.');
          expect(chips[1].attrs['aria-pressed']).toBe('true');
          // The other apps stay unavailable after a pick, without losing focus.
          expect(chips.every((c) => c.attrs['aria-disabled'] === 'true' && !c.disabled)).toBe(true);
        });

        it('keeps everything usable when the pick fails', async () => {
          const { nodes, chips } = await run(async () => ({ ok: false, error: 'WooCommerce could not be added right now.' }));
          chips[2].listeners.click({ currentTarget: chips[2] });
          await flush();
          await flush();
          expect(nodes['quick-status'].textContent).toBe('WooCommerce could not be added right now.');
          expect(nodes['example-request'].textContent).toBe('Connect my Telegram bot to AnythingMCP.');
          // aria-disabled, never disabled: keyboard focus stays on the chip.
          expect(chips.every((c) => c.attrs['aria-disabled'] === 'false' && !c.disabled)).toBe(true);
        });

        it('turns another app into the request, and opens Claude with it on Continue', async () => {
          const { nodes, open } = await run(async () => ({}));
          nodes['other-app'].value = '  HubSpot   CRM ';
          nodes['other-app'].listeners.input({});
          expect(nodes['example-request'].textContent).toBe('Connect my HubSpot CRM to AnythingMCP.');
          nodes['other-app'].value = '';
          nodes['other-app'].listeners.input({});
          expect(nodes['example-request'].textContent).toBe('Connect my Telegram bot to AnythingMCP.');

          nodes.continue.listeners.click({});
          expect(open).toHaveBeenCalledWith(
            'https://claude.ai/new?q=Connect%20my%20Telegram%20bot%20to%20AnythingMCP.',
            '_blank',
            'noopener',
          );
        });

        it('opens no second tab on a touch device, whatever its user agent says', async () => {
          const { nodes, open } = await run(async () => ({}), true);
          expect(nodes.continue.listeners.click).toBeUndefined();
          expect(open).not.toHaveBeenCalled();
        });

        // A phone gets no chat tab, so the tap on Continue copies the request
        // instead. Continue is where 60% of phone users were lost for two
        // weeks: the copy must not be able to change what the tap does.
        describe('on a phone, Continue also copies the request', () => {
          const IPHONE =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
          const MAC =
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
          /** A click as the browser hands it over: the test fails if the page stops or redirects it. */
          const tap = () => ({
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            stopImmediatePropagation: jest.fn(),
            defaultPrevented: false,
            returnValue: true,
          });
          const untouched = (event: ReturnType<typeof tap>) => {
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(event.stopPropagation).not.toHaveBeenCalled();
            expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
            expect(event.returnValue).toBe(true);
          };

          it('has the line for it near the request, empty and hidden, on every device', async () => {
            arrange();
            const phone = (await showPage(picking, IPHONE))._sent as string;
            const desktop = (await showPage(picking, MAC))._sent as string;
            expect(phone).toContain('<p class="copied" id="request-copied" role="status" aria-live="polite" data-phone="1" hidden></p>');
            expect(desktop).toContain('<p class="copied" id="request-copied" role="status" aria-live="polite" hidden></p>');
            for (const page of [phone, desktop]) {
              expect(page.indexOf('id="example-request"')).toBeLessThan(page.indexOf('id="request-copied"'));
              expect(page.indexOf('id="request-copied"')).toBeLessThan(page.indexOf('id="continue"'));
            }
            // Continue itself is the same link as before on a phone: no new attribute.
            expect(phone).toContain('<a class="button" id="continue" href="http://mcp.test/callback" data-client="Claude">Continue to Claude</a>');
          });

          it('copies inside the tap and says so, without preventing the default action or opening a window', async () => {
            let settle: () => void = () => undefined;
            const writeText = jest.fn(() => new Promise<void>((resolve) => (settle = resolve)));
            const { nodes, open } = await run(async () => ({}), true, { userAgent: IPHONE, navigator: { clipboard: { writeText } } });
            nodes['example-request'].textContent = 'Send me a test message on Telegram.';
            const event = tap();

            // The listener returns before the clipboard answers: the browser follows the link at once.
            expect(nodes.continue.listeners.click(event)).toBeUndefined();
            expect(writeText).toHaveBeenCalledTimes(1);
            expect(writeText).toHaveBeenCalledWith('Send me a test message on Telegram.');
            expect(nodes['request-copied'].hidden).toBe(true);
            untouched(event);
            expect(open).not.toHaveBeenCalled();

            settle();
            await flush();
            expect(nodes['request-copied'].textContent).toBe('Copied. Paste it in a new chat in Claude.');
            expect(nodes['request-copied'].hidden).toBe(false);
            untouched(event);
            expect(open).not.toHaveBeenCalled();
            // Nothing was changed on the link either.
            expect(nodes.continue.attrs).toEqual({ 'data-client': 'Claude' });
          });

          it.each([
            ['refuses', () => Promise.reject(new Error('NotAllowedError'))],
            ['throws', () => {
              throw new Error('SecurityError');
            }],
            ['never answers', () => new Promise<void>(() => undefined)],
            ['answers with something that is no promise', () => undefined as unknown as Promise<void>],
          ])('changes nothing when the clipboard %s', async (_what, writeText) => {
            const { nodes, open } = await run(async () => ({}), true, {
              userAgent: IPHONE,
              navigator: { clipboard: { writeText: jest.fn(writeText) } },
            });
            const event = tap();
            expect(() => nodes.continue.listeners.click(event)).not.toThrow();
            await flush();
            await flush();
            untouched(event);
            expect(open).not.toHaveBeenCalled();
            expect(nodes['request-copied'].hidden).toBe(true);
            expect(nodes['request-copied'].textContent).toBe('');
          });

          it('adds nothing to Continue where there is no clipboard', async () => {
            for (const navigator of [{}, { clipboard: {} }]) {
              const { nodes } = await run(async () => ({}), true, { userAgent: IPHONE, navigator });
              expect(nodes.continue.listeners).toEqual({});
            }
          });

          it('copies on a touch device that asked for the desktop site, where no chat tab opens either', async () => {
            const writeText = jest.fn().mockResolvedValue(undefined);
            const { nodes, open } = await run(async () => ({}), true, { userAgent: MAC, navigator: { clipboard: { writeText } } });
            expect(Object.keys(nodes.continue.listeners)).toEqual(['click']);
            nodes.continue.listeners.click(tap());
            await flush();
            expect(writeText).toHaveBeenCalledWith('Connect my Telegram bot to AnythingMCP.');
            expect(open).not.toHaveBeenCalled();
            expect(nodes['request-copied'].hidden).toBe(false);
          });

          it('leaves a desktop exactly as it was: the chat tab opens, and nothing is copied', async () => {
            const writeText = jest.fn().mockResolvedValue(undefined);
            const { nodes, open } = await run(async () => ({}), false, { userAgent: MAC, navigator: { clipboard: { writeText } } });
            const event = tap();
            nodes.continue.listeners.click(event);
            await flush();
            expect(open).toHaveBeenCalledTimes(1);
            expect(open).toHaveBeenCalledWith('https://claude.ai/new?q=Connect%20my%20Telegram%20bot%20to%20AnythingMCP.', '_blank', 'noopener');
            expect(writeText).not.toHaveBeenCalled();
            expect(nodes['request-copied'].hidden).toBe(true);
            untouched(event);
          });

          it('is written so that it cannot stop, delay or redirect the tap', async () => {
            const { page } = await run(async () => ({}), true, { userAgent: IPHONE });
            const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
            const copy = script.slice(script.indexOf('// A phone gets no chat tab'));
            expect(copy).toContain("cont.addEventListener('click'");
            for (const forbidden of ['preventDefault', 'stopPropagation', 'window.open', 'location', 'await', 'return false', 'setTimeout', '.click(', 'href', 'setAttribute']) {
              expect(copy).not.toContain(forbidden);
            }
            // One click listener on Continue in the whole page per device: this one, or the desktop's chat tab.
            expect(script.match(/cont\.addEventListener\('click'/g)).toHaveLength(2);
          });
        });
      });

      // A second tab on a phone takes over and the authorization in the first
      // one is never finished (about 200 codes a day were left unexchanged).
      it.each([
        ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'],
        ['Android', 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'],
        ['iPad', 'Mozilla/5.0 (iPad; CPU OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'],
      ])('goes straight back to Claude on %s, without a chat tab', async (_device, userAgent) => {
        arrange();
        const page = (await showPage(picking, userAgent))._sent as string;
        expect(page).toContain('Continue to Claude');
        expect(page).toContain('href="http://mcp.test/callback"');
        expect(page).not.toContain('data-open-chat="');
      });

      it('keeps the chat tab on a desktop browser', async () => {
        arrange();
        const page = (
          await showPage(picking, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')
        )._sent as string;
        expect(page).toContain('href="http://mcp.test/callback" data-open-chat="https://claude.ai/new"');
      });

      it('opens a new chat only for a code sent to claude.ai', async () => {
        arrange();
        store.getOAuthSession.mockResolvedValue({
          sessionId: 's1',
          state: 'x',
          clientId: 'client-abc',
          redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
          expiresAt: Date.now() + 20 * 60_000,
        } as any);
        store.getClient.mockResolvedValue({ client_id: 'client-abc', client_name: 'ChatGPT' } as any);
        const page = (await showPage())._sent as string;
        expect(page).toContain('Continue to ChatGPT');
        expect(page).not.toContain('data-open-chat="');
      });

      it('is left out, with its cookie, when this instance cannot add connectors', async () => {
        arrange();
        const res = await showPage(make(CLOUD, false));
        expect(res._sent).toContain('Claude is connected');
        expect(res._sent).not.toContain('id="quick-apps"');
        expect(res._cookies['first_app_csrf']).toBeUndefined();
      });

      it('adds the picked app for the user\'s workspace, without secrets, and records it', async () => {
        arrange();
        const res = await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' });

        expect(res._json).toEqual({
          ok: true,
          adapter: 'telegram-bot',
          name: 'Telegram',
          request: 'Finish setting up my Telegram connector.',
        });
        const ctx = {
          userId: 'u1',
          organizationId: 'org-1',
          serverIds: ['srv-1'],
          dashboardBase: 'https://cloud.example',
          assistant: 'claude',
          profile: 'default',
        };
        expect(grants.resolve).toHaveBeenCalledWith('client-abc', 'u1');
        expect(provider.canSetUp).toHaveBeenCalledWith(ctx);
        // Recorded apart from chat installs (setup_completed via 'post_approve').
        expect(provider.install).toHaveBeenCalledWith(ctx, { adapter: 'telegram-bot' }, { via: 'post_approve' });
        expect(productEvents.log).toHaveBeenCalledWith({
          event: 'post_approve_app_picked',
          userId: 'u1',
          organizationId: 'org-1',
          metadata: { adapterSlug: 'telegram-bot', client: 'Claude', status: 'added' },
        });
      });

      it('adds the app to the workspace this connection was granted, not the primary one', async () => {
        arrange();
        // The user's own organization is org-1; they picked org-2 on "Choose what to connect".
        grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
        const res = await pick({ adapter: 'woocommerce', csrf: 'pick-tok' });

        expect(res._json.ok).toBe(true);
        const ctx = expect.objectContaining({ userId: 'u1', organizationId: 'org-2', serverIds: [] });
        expect(provider.canSetUp).toHaveBeenCalledWith(ctx);
        expect(provider.install).toHaveBeenCalledWith(ctx, { adapter: 'woocommerce' }, { via: 'post_approve' });
        expect(productEvents.log).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'post_approve_app_picked', organizationId: 'org-2' }),
        );
      });

      it('adds the app to the user\'s own workspace when the client has no grant', async () => {
        arrange();
        grants.resolve.mockResolvedValue(null);
        await pick({ adapter: 'woocommerce', csrf: 'pick-tok' });

        expect(provider.install).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: 'org-1', serverIds: [] }),
          { adapter: 'woocommerce' },
          { via: 'post_approve' },
        );
      });

      it.each([
        ['a grant that reaches nothing', { mode: 'none' }],
        [
          'servers in two workspaces',
          {
            mode: 'servers',
            servers: [
              { id: 'srv-1', organizationId: 'org-1' },
              { id: 'srv-2', organizationId: 'org-2' },
            ],
          },
        ],
      ])('refuses a pick for %s: there is no one workspace to add it to', async (_label, grant) => {
        arrange();
        grants.resolve.mockResolvedValue(grant);
        const res = await pick({ adapter: 'woocommerce', csrf: 'pick-tok' });

        expect(res._status).toBe(403);
        expect(provider.install).not.toHaveBeenCalled();
      });

      it.each([
        ['no token', {}],
        ['a wrong token', { csrf: 'other' }],
      ])('refuses a pick with %s (CSRF)', async (_label, extra) => {
        arrange();
        const res = await pick({ adapter: 'telegram-bot', ...extra });
        expect(res._status).toBe(403);
        expect(res._json.ok).toBe(false);
        expect(provider.install).not.toHaveBeenCalled();
      });

      it('refuses a pick without the signed login cookie of the paused authorization', async () => {
        arrange();
        const res = await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' }, { first_app_csrf: 'pick-tok' });
        expect(res._status).toBe(403);
        expect(provider.install).not.toHaveBeenCalled();
      });

      it('refuses a user who may not add connectors', async () => {
        arrange({ role: 'VIEWER' });
        provider.canSetUp.mockResolvedValue(false);
        const res = await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' });
        expect(res._status).toBe(403);
        expect(res._json.error).toContain('admins and editors');
        expect(provider.install).not.toHaveBeenCalled();
      });

      it('installs only the page\'s own apps', async () => {
        arrange();
        const res = await pick({ adapter: 'hubspot', csrf: 'pick-tok' });
        expect(res._status).toBe(400);
        expect(provider.install).not.toHaveBeenCalled();
      });

      it('lets the user continue when the install fails, and records why', async () => {
        arrange();
        provider.install.mockResolvedValue({ isError: true, body: { error: 'Connector limit reached' } });
        const res = await pick({ adapter: 'woocommerce', csrf: 'pick-tok' });
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ ok: false, error: expect.stringContaining('You can still continue') });
        expect(productEvents.log).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'post_approve_app_picked',
            metadata: { adapterSlug: 'woocommerce', client: 'Claude', status: 'failed', error: 'Connector limit reached' },
          }),
        );
      });

      it('does not exist on self-hosted', async () => {
        arrange();
        const res = await pick(
          { adapter: 'telegram-bot', csrf: 'pick-tok' },
          undefined,
          make({ mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true }),
        );
        expect(res._status).toBe(404);
        expect(provider.install).not.toHaveBeenCalled();
      });

      describe('the one-tap Telegram bot', () => {
        const LINK = 'https://t.me/newbot/AnythingMCPBot/amcp_1a2b3c4d_bot?name=My%20AnythingMCP%20bot';
        /** Opens the manager bot's chat with the setup code: for a bot whose username was changed. */
        const CLAIM = 'https://t.me/AnythingMCPBot?start=1a2b3c4d';
        const DESKTOP_UA =
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
        const PHONE_UA =
          'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
        const COOKIES = { first_app_csrf: 'pick-tok', login_user: LOGIN_USER };
        let telegram: { isEnabledFor: jest.Mock; begin: jest.Mock; status: jest.Mock; saveToken: jest.Mock };
        let oneTap: LoginController;

        /** A controller whose instance has the Telegram service, found by its token. */
        const makeWithTelegram = (service: object, deployment: object = CLOUD) =>
          new LoginController(
            authService as unknown as AuthService,
            cloudPrisma as unknown as PrismaService,
            config as unknown as ConfigService,
            store as unknown as PrismaOAuthStore,
            sso as unknown as SsoService,
            deployment as any,
            grants as any,
            productEvents as any,
            licenseGuard as any,
            eligibility as any,
            undefined,
            { get: (token: unknown) => (token === TELEGRAM_ONE_TAP ? service : { get: () => provider }) } as any,
          );

        beforeEach(() => {
          telegram = {
            isEnabledFor: jest.fn().mockReturnValue(true),
            begin: jest.fn().mockResolvedValue({ link: LINK, username: 'amcp_1a2b3c4d_bot', claimLink: CLAIM }),
            status: jest.fn().mockResolvedValue({ state: 'waiting' }),
            saveToken: jest.fn().mockResolvedValue({ ok: true, bot: '@my_own_bot' }),
          };
          provider.install.mockResolvedValue({ connectorId: 'conn-1', body: { installed: 'Telegram Bot', status: 'needs_input' } });
          oneTap = makeWithTelegram(telegram);
        });

        const request = (signedCookies: Record<string, string> = COOKIES, userAgent = DESKTOP_UA) =>
          makeReq({ cookies: { oauth_session: 's1' }, signedCookies, headers: { host: 'mcp.test', 'user-agent': userAgent } } as any);
        const status = async (
          body: Record<string, unknown>,
          signedCookies: Record<string, string> = COOKIES,
          c: LoginController = oneTap,
          userAgent = DESKTOP_UA,
        ) => {
          const res = makeRes();
          await c.telegramOneTapStatus(request(signedCookies, userAgent), body, res);
          return res;
        };
        const saveToken = async (
          body: Record<string, unknown>,
          signedCookies: Record<string, string> = COOKIES,
          c: LoginController = oneTap,
        ) => {
          const res = makeRes();
          await c.telegramOneTapToken(request(signedCookies), body, res);
          return res;
        };
        /** The page without what differs on every render. */
        const stable = (page: string) => page.replace(/data-csrf="[^"]+"/, 'data-csrf="X"');

        describe('when it is off', () => {
          it('leaves the page exactly as it is without a manager bot', async () => {
            arrange();
            const page = (await showPage(picking, DESKTOP_UA))._sent as string;
            for (const part of ['tg-setup', 'tg-create', 'amcpTelegram', 'Create your Telegram bot', 'Paste its token', '/auth/first-app/telegram']) {
              expect(page).not.toContain(part);
            }
          });

          it('leaves the page exactly as it is for a workspace outside the allowlist', async () => {
            arrange();
            telegram.isEnabledFor.mockImplementation((organizationId: string) => organizationId === 'org-9');
            const without = (await showPage(picking, DESKTOP_UA))._sent as string;
            const outside = (await showPage(oneTap, DESKTOP_UA))._sent as string;
            expect(telegram.isEnabledFor).toHaveBeenCalledWith('org-1');
            expect(stable(outside)).toBe(stable(without));
          });

          it('adds Telegram as before, with no link', async () => {
            arrange();
            telegram.isEnabledFor.mockReturnValue(false);
            const res = await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' }, undefined, oneTap);
            expect(res._json).toEqual({
              ok: true,
              adapter: 'telegram-bot',
              name: 'Telegram',
              request: 'Finish setting up my Telegram connector.',
            });
            expect(telegram.begin).not.toHaveBeenCalled();
          });

          it('refuses the status and the token requests', async () => {
            arrange();
            telegram.isEnabledFor.mockReturnValue(false);
            expect((await status({ csrf: 'pick-tok' }))._status).toBe(403);
            expect((await saveToken({ csrf: 'pick-tok', token: 'x' }))._status).toBe(403);
            expect(telegram.status).not.toHaveBeenCalled();
            expect(telegram.saveToken).not.toHaveBeenCalled();
          });
        });

        describe('the page', () => {
          it('on a desktop holds the hidden panel: button, QR code, status and the token option', async () => {
            arrange();
            const page = (await showPage(oneTap, DESKTOP_UA))._sent as string;

            expect(page).toContain('<div class="tg" id="tg-setup" hidden>');
            expect(page).toContain(
              '<a class="tg-create" id="tg-create" href="https://t.me/" target="_blank" rel="noopener noreferrer">Create your Telegram bot</a>',
            );
            expect(page).toContain('<figure class="tg-qr" id="tg-qr" hidden>');
            expect(page).toContain('<figcaption>Scan with your phone</figcaption>');
            expect(page).toContain('<p class="tg-status" id="tg-status" role="status" aria-live="polite"></p>');
            // Whose bot this is, and where someone who has one goes.
            expect(page).toContain(
              '<p class="tg-help" id="tg-help">This creates a new bot that belongs to you: it appears in your own @BotFather list, and you can rename it, add a picture and use it with your customers. Already have a bot? Paste its token below.</p>',
            );
            // What is left to do once the bot is connected: empty and hidden until then.
            expect(page).toContain('<p class="tg-next" id="tg-next" role="status" aria-live="polite" hidden></p>');
            expect(page.indexOf('id="tg-status"')).toBeLessThan(page.indexOf('id="tg-next"'));
            // The second way in, hidden until it is needed: an ordinary link on its own button.
            expect(page).toContain('<div class="tg-link" id="tg-link" hidden>');
            expect(page).toContain(
              '<a class="tg-link-btn" id="tg-link-btn" href="https://t.me/" target="_blank" rel="noopener noreferrer">Changed the username? Link your bot</a>',
            );
            // With its own QR code beside it: on a desktop the bot was usually made on the phone.
            expect(page).toContain(
              '<p class="tg-hint" id="tg-hint">Telegram opens our setup bot: press Start there, then come back here. Bot made on your phone? Scan the code.</p>',
            );
            expect(page).toContain('<figure class="tg-qr" id="tg-link-qr" hidden>');
            expect(page.indexOf('id="tg-link-qr"')).toBeGreaterThan(page.indexOf('id="tg-link"'));
            expect(page.indexOf('id="tg-link-qr"')).toBeLessThan(page.indexOf('id="tg-paste"'));
            expect(page).toContain('a.tg-link-btn:focus-visible');
            expect(page.indexOf('id="tg-create"')).toBeLessThan(page.indexOf('id="tg-link"'));
            expect(page.indexOf('id="tg-link"')).toBeLessThan(page.indexOf('id="tg-paste"'));
            // Collapsed until asked for; a labelled field and a real button.
            expect(page).toContain('<details class="tg-paste" id="tg-paste">');
            expect(page).toContain('<summary>Already have a bot? Paste its token</summary>');
            expect(page).toContain('<label for="tg-token">Bot token</label>');
            expect(page).toContain('<button type="submit" class="secondary" id="tg-token-save">Save</button>');
            expect(page).toContain('a.tg-create:focus-visible');
            // Inside the picker, before Continue, which stays the one button and is unchanged.
            expect(page.indexOf('id="quick-apps"')).toBeLessThan(page.indexOf('id="tg-setup"'));
            expect(page.indexOf('id="tg-setup"')).toBeLessThan(page.indexOf('Continue to Claude'));
            expect(page.match(/class="button"/g)).toHaveLength(1);
            expect(page).toContain(
              '<a class="button" id="continue" href="http://mcp.test/callback" data-open-chat="https://claude.ai/new" data-client="Claude">Continue to Claude</a>',
            );
          });

          it('on a phone or tablet has no QR code: the button opens the Telegram app', async () => {
            arrange();
            for (const userAgent of [
              PHONE_UA,
              'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
              'Mozilla/5.0 (iPad; CPU OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
            ]) {
              const page = (await showPage(oneTap, userAgent))._sent as string;
              expect(page).toContain('id="tg-setup" hidden');
              expect(page).toContain('Create your Telegram bot</a>');
              expect(page).toContain('Changed the username? Link your bot</a>');
              expect(page).toContain('<p class="tg-hint" id="tg-hint">Telegram opens our setup bot: press Start there, then come back here.</p>');
              expect(page).not.toContain('Scan the code');
              expect(page).not.toContain('<figure');
              expect(page).not.toContain('Scan with your phone');
              // Continue as it is on a phone: straight to the callback, no chat tab.
              expect(page).toContain('<a class="button" id="continue" href="http://mcp.test/callback" data-client="Claude">Continue to Claude</a>');
            }
          });

          it('changes nothing else on the page', async () => {
            arrange();
            const without = (await showPage(picking, DESKTOP_UA))._sent as string;
            const withPanel = (await showPage(oneTap, DESKTOP_UA))._sent as string;
            // Everything up to the picker's end, and from Continue to the script, is the same markup.
            const head = (page: string) => stable(page.slice(page.indexOf('<main'), page.indexOf('id="quick-status"')));
            const tail = (page: string) => page.slice(page.indexOf('<a class="button" id="continue"'), page.indexOf('<script>'));
            expect(head(withPanel)).toBe(head(without));
            expect(tail(withPanel)).toBe(tail(without));
          });

          it('never navigates or opens a window from its script, and never touches Continue', () => {
            for (const forbidden of ['window.open', 'location', '.click(', "getElementById('continue').add", 'cont.addEventListener', 'cont.setAttribute']) {
              expect(TELEGRAM_PANEL_SCRIPT).not.toContain(forbidden);
            }
          });
        });

        describe('picking Telegram', () => {
          it('starts a setup for the added connector and answers with the two links and their QR codes', async () => {
            arrange();
            const res = makeRes();
            await oneTap.pickFirstApp(request(), { adapter: 'telegram-bot', csrf: 'pick-tok' }, res);

            expect(telegram.begin).toHaveBeenCalledWith({
              userId: 'u1',
              organizationId: 'org-1',
              connectorId: 'conn-1',
              // For the bot's own messages: the button's name, and the link to a new chat.
              client: { name: 'Claude', claude: true },
            });
            expect(res._json).toEqual({
              ok: true,
              adapter: 'telegram-bot',
              name: 'Telegram',
              request: 'Finish setting up my Telegram connector.',
              telegram: {
                link: LINK,
                claim: CLAIM,
                qr: expect.stringMatching(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/),
                claimQr: expect.stringMatching(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/),
              },
            });
            expect(res._json.telegram.claimQr).not.toBe(res._json.telegram.qr);
            for (const qr of [res._json.telegram.qr, res._json.telegram.claimQr]) {
              const svg = Buffer.from(qr.split(',')[1], 'base64').toString('utf8');
              expect(svg.startsWith('<svg')).toBe(true);
              expect(svg).not.toContain('<script');
            }
            expect(productEvents.log).toHaveBeenCalledWith({
              event: 'telegram_bot_link_offered',
              userId: 'u1',
              organizationId: 'org-1',
              metadata: { adapterSlug: 'telegram-bot', client: 'Claude', device: 'desktop' },
            });
          });

          it('sends no QR code to a phone', async () => {
            arrange();
            const res = makeRes();
            await oneTap.pickFirstApp(request(COOKIES, PHONE_UA), { adapter: 'telegram-bot', csrf: 'pick-tok' }, res);
            expect(res._json.telegram).toEqual({ link: LINK, claim: CLAIM });
            expect(productEvents.log).toHaveBeenCalledWith(
              expect.objectContaining({ event: 'telegram_bot_link_offered', metadata: expect.objectContaining({ device: 'mobile' }) }),
            );
          });

          it('starts the setup in the workspace the connection was granted', async () => {
            arrange();
            grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
            await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' }, undefined, oneTap);
            expect(telegram.isEnabledFor).toHaveBeenCalledWith('org-2');
            expect(telegram.begin).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-2', connectorId: 'conn-1' }));
          });

          it('starts none for another app, a failed install, or a service that cannot start one', async () => {
            arrange();
            expect((await pick({ adapter: 'woocommerce', csrf: 'pick-tok' }, undefined, oneTap))._json.telegram).toBeUndefined();
            provider.install.mockResolvedValue({ isError: true, body: { error: 'Connector limit reached' } });
            expect((await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' }, undefined, oneTap))._json.ok).toBe(false);
            expect(telegram.begin).not.toHaveBeenCalled();

            provider.install.mockResolvedValue({ connectorId: 'conn-1', body: {} });
            telegram.begin.mockResolvedValue(null);
            expect((await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' }, undefined, oneTap))._json).toEqual({
              ok: true,
              adapter: 'telegram-bot',
              name: 'Telegram',
              request: 'Finish setting up my Telegram connector.',
            });
            telegram.begin.mockRejectedValue(new Error('database down'));
            expect((await pick({ adapter: 'telegram-bot', csrf: 'pick-tok' }, undefined, oneTap))._json.telegram).toBeUndefined();
            expect(productEvents.log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'telegram_bot_link_offered' }));
          });
        });

        describe('POST /auth/first-app/telegram/status', () => {
          it('answers where the setup stands, for the user and workspace of the paused authorization', async () => {
            arrange();
            const res = await status({ csrf: 'pick-tok' });
            expect(res._status).toBe(200);
            expect(res._json).toEqual({ ok: true, state: 'waiting' });
            expect(telegram.status).toHaveBeenCalledWith({
              organizationId: 'org-1',
              userId: 'u1',
              opened: false,
              claimOffered: false,
              device: 'desktop',
            });
            expect(grants.resolve).toHaveBeenCalledWith('client-abc', 'u1');
          });

          it('adds the request to try once the bot is connected', async () => {
            arrange();
            telegram.status.mockResolvedValue({ state: 'connected', bot: '@amcp_1a2b3c4d_bot', startUrl: 'https://t.me/amcp_1a2b3c4d_bot' });
            expect((await status({ csrf: 'pick-tok' }))._json).toEqual({
              ok: true,
              state: 'connected',
              bot: '@amcp_1a2b3c4d_bot',
              startUrl: 'https://t.me/amcp_1a2b3c4d_bot',
              request: 'Send me a test message on Telegram.',
            });
          });

          it('passes on a click on the link only when the page says so, with the device', async () => {
            arrange();
            await status({ csrf: 'pick-tok', opened: true }, COOKIES, oneTap, PHONE_UA);
            expect(telegram.status).toHaveBeenLastCalledWith({
              organizationId: 'org-1',
              userId: 'u1',
              opened: true,
              claimOffered: false,
              device: 'mobile',
            });
            await status({ csrf: 'pick-tok', opened: 'yes' });
            expect(telegram.status).toHaveBeenLastCalledWith(expect.objectContaining({ opened: false }));
          });

          it('passes on that "Link your bot" is shown, and what the server knows about the wait', async () => {
            arrange();
            telegram.status.mockResolvedValue({ state: 'waiting', unmatched: true });
            expect((await status({ csrf: 'pick-tok', offered: true }))._json).toEqual({ ok: true, state: 'waiting', unmatched: true });
            expect(telegram.status).toHaveBeenLastCalledWith(expect.objectContaining({ claimOffered: true }));
            await status({ csrf: 'pick-tok', offered: 1 });
            expect(telegram.status).toHaveBeenLastCalledWith(expect.objectContaining({ claimOffered: false }));

            telegram.status.mockResolvedValue({ state: 'waiting', claimed: true });
            expect((await status({ csrf: 'pick-tok' }))._json).toEqual({ ok: true, state: 'waiting', claimed: true });
          });

          it.each([
            ['no CSRF token', {}, COOKIES],
            ['a wrong CSRF token', { csrf: 'other' }, COOKIES],
            ['no CSRF cookie', { csrf: 'pick-tok' }, { login_user: LOGIN_USER }],
            ['no signed login cookie', { csrf: 'pick-tok' }, { first_app_csrf: 'pick-tok' }],
            ['a login cookie that is not a profile', { csrf: 'pick-tok' }, { first_app_csrf: 'pick-tok', login_user: 'garbage' }],
          ])('refuses a request with %s', async (_label, body, signedCookies) => {
            arrange();
            const res = await status(body, signedCookies as Record<string, string>);
            expect(res._status).toBe(403);
            expect(res._json.ok).toBe(false);
            expect(telegram.status).not.toHaveBeenCalled();
          });

          it('refuses without a pending authorization, or for one server\'s own URL', async () => {
            arrange({ session: false });
            store.getOAuthSession.mockResolvedValue(null as any);
            expect((await status({ csrf: 'pick-tok' }))._status).toBe(403);

            arrange();
            expect((await status({ csrf: 'pick-tok' }, { ...COOKIES, mcp_resource: 'srv-9' }))._status).toBe(403);
            expect(telegram.status).not.toHaveBeenCalled();
          });

          it('refuses a viewer, a grant without one workspace, and self-hosted', async () => {
            arrange({ role: 'VIEWER' });
            expect((await status({ csrf: 'pick-tok' }))._status).toBe(403);

            arrange();
            grants.resolve.mockResolvedValue({ mode: 'none' });
            expect((await status({ csrf: 'pick-tok' }))._status).toBe(403);

            arrange();
            grants.resolve.mockResolvedValue(null);
            const selfHosted = makeWithTelegram(telegram, { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true });
            expect((await status({ csrf: 'pick-tok' }, COOKIES, selfHosted))._status).toBe(403);
            expect(telegram.status).not.toHaveBeenCalled();
          });

          it('checks the role in the workspace the connection was granted', async () => {
            arrange();
            grants.resolve.mockResolvedValue({ mode: 'organization', organizationId: 'org-2' });
            await status({ csrf: 'pick-tok' });
            expect(cloudPrisma.organizationMember.findFirst).toHaveBeenLastCalledWith({
              where: { userId: 'u1', organizationId: 'org-2', deactivatedAt: null },
              select: { role: true },
            });
            expect(telegram.status).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-2' }));
          });

          it('answers "try again", not "expired", when the status cannot be read', async () => {
            arrange();
            telegram.status.mockRejectedValue(new Error('database down'));
            const res = await status({ csrf: 'pick-tok' });
            expect(res._status).toBe(503);
            expect(res._json.ok).toBeUndefined();
          });
        });

        describe('POST /auth/first-app/telegram/token', () => {
          const TOKEN = '8123456789:AAGpastedTokenForTestsOnly0123456789abc';

          it('saves a pasted token for the user and workspace of the paused authorization', async () => {
            arrange();
            const res = await saveToken({ csrf: 'pick-tok', token: TOKEN });
            expect(telegram.saveToken).toHaveBeenCalledWith({ organizationId: 'org-1', userId: 'u1', token: TOKEN });
            expect(res._json).toEqual({
              ok: true,
              bot: '@my_own_bot',
              state: 'connected',
              request: 'Send me a test message on Telegram.',
            });
            // The token is never sent back.
            expect(JSON.stringify(res._json)).not.toContain(TOKEN);
          });

          it('passes on why a token was refused', async () => {
            arrange();
            telegram.saveToken.mockResolvedValue({ ok: false, error: 'Telegram refused the bot token.' });
            expect((await saveToken({ csrf: 'pick-tok', token: TOKEN }))._json).toEqual({ ok: false, error: 'Telegram refused the bot token.' });
          });

          it.each([
            ['no CSRF token', { token: TOKEN }, COOKIES],
            ['a wrong CSRF token', { csrf: 'other', token: TOKEN }, COOKIES],
            ['no signed login cookie', { csrf: 'pick-tok', token: TOKEN }, { first_app_csrf: 'pick-tok' }],
          ])('refuses a request with %s', async (_label, body, signedCookies) => {
            arrange();
            const res = await saveToken(body, signedCookies as Record<string, string>);
            expect(res._status).toBe(403);
            expect(telegram.saveToken).not.toHaveBeenCalled();
          });

          it('refuses a viewer', async () => {
            arrange({ role: 'VIEWER' });
            expect((await saveToken({ csrf: 'pick-tok', token: TOKEN }))._status).toBe(403);
            expect(telegram.saveToken).not.toHaveBeenCalled();
          });

          it('keeps the token out of the log when saving fails', async () => {
            arrange();
            const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            telegram.saveToken.mockRejectedValue(new Error(`could not store ${TOKEN}`));
            const res = await saveToken({ csrf: 'pick-tok', token: TOKEN });
            expect(res._json).toEqual({ ok: false, error: 'The token could not be saved. Try again.' });
            expect(warn.mock.calls.flat().join(' ')).not.toContain(TOKEN);
            warn.mockRestore();
          });
        });

        describe('its script', () => {
          type Node = {
            textContent: string;
            hidden: boolean;
            value: string;
            attrs: Record<string, string>;
            listeners: Record<string, (e?: unknown) => void>;
            getAttribute(n: string): string | null;
            setAttribute(n: string, v: string): void;
            addEventListener(t: string, f: (e?: unknown) => void): void;
            querySelectorAll(): Node[];
          };
          const node = (attrs: Record<string, string> = {}, text = ''): Node => ({
            textContent: text,
            hidden: false,
            value: '',
            attrs,
            listeners: {},
            getAttribute(n) {
              return n in this.attrs ? this.attrs[n] : null;
            },
            setAttribute(n, v) {
              this.attrs[n] = v;
            },
            addEventListener(t, f) {
              this.listeners[t] = f;
            },
            querySelectorAll() {
              return [];
            },
          });
          const flush = async () => {
            for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
          };
          const PICKED = {
            ok: true,
            name: 'Telegram',
            request: 'Finish setting up my Telegram connector.',
            telegram: {
              link: LINK,
              claim: CLAIM,
              qr: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
              claimQr: 'data:image/svg+xml;base64,PHN2Zz5jbGFpbTwvc3ZnPg==',
            },
          };

          /**
           * Runs the page's script against a minimal DOM built from the page,
           * with a clock the test moves: timers fire in `advance`.
           */
          const run = async (opts: { userAgent?: string; touch?: boolean } = {}) => {
            arrange();
            const page = (await showPage(oneTap, opts.userAgent ?? DESKTOP_UA))._sent as string;
            const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
            const chips = [...page.matchAll(/data-adapter="([^"]+)" data-name="([^"]+)"/g)].map((m) =>
              node({ 'data-adapter': m[1], 'data-name': m[2], 'aria-pressed': 'false' }),
            );
            const picker = node({ 'data-csrf': /data-csrf="([^"]+)"/.exec(page)![1] });
            picker.hidden = true;
            picker.querySelectorAll = () => chips;
            const cont = /<a class="button" id="continue"([^>]*)>/.exec(page)![1];
            const nodes: Record<string, Node> = {
              'copy-request': node(),
              'example-request': node({}, 'Connect my Telegram bot to AnythingMCP.'),
              'first-sub': node({}, 'Your workspace has no apps yet.'),
              'first-body': node({}, 'Claude finds the connector and sets it up with you.'),
              'quick-apps': picker,
              'quick-status': node(),
              'other-app': node(),
              continue: node({
                'data-client': 'Claude',
                ...(cont.includes('data-open-chat') ? { 'data-open-chat': 'https://claude.ai/new' } : {}),
              }),
            };
            // Every element of the panel the page really has, hidden where its markup says so.
            for (const m of page.matchAll(/<[a-z]+[^>]*\bid="(tg-[a-z-]+)"([^>]*)>/g)) {
              nodes[m[1]] = node();
              nodes[m[1]].hidden = /\shidden\b/.test(m[2]);
            }

            const clock = { now: 1_000_000 };
            let timers: Array<{ id: number; at: number; f: () => void }> = [];
            let nextId = 1;
            const answers = {
              status: (): unknown => ({ ok: true, state: 'waiting' }),
              token: (): unknown => ({ ok: true, state: 'connected', bot: '@my_own_bot', request: 'Send me a test message on Telegram.' }),
            };
            const fetch = jest.fn(async (url: string, init?: { body: string }) => ({
              json: async () => {
                if (url === '/auth/first-app/telegram/status') return answers.status();
                if (url === '/auth/first-app/telegram/token') return answers.token();
                // The server sends the link with Telegram only.
                const adapter = JSON.parse(init?.body ?? '{}').adapter;
                return adapter === 'telegram-bot' ? PICKED : { ok: true, name: 'WooCommerce', request: 'Finish setting up my WooCommerce connector.' };
              },
            }));
            const open = jest.fn();
            const documentListeners: Record<string, () => void> = {};
            const windowListeners: Record<string, () => void> = {};
            const document = {
              hidden: false,
              getElementById: (id: string) => nodes[id] ?? null,
              addEventListener: (t: string, f: () => void) => {
                documentListeners[t] = f;
              },
            };
            const window: Record<string, any> = {
              fetch,
              JSON,
              open,
              matchMedia: (q: string) => ({ matches: !!opts.touch && q === '(pointer: coarse)' }),
              addEventListener: (t: string, f: () => void) => {
                windowListeners[t] = f;
              },
            };
            require('vm').runInNewContext(script, {
              document,
              navigator: {},
              window,
              fetch,
              JSON,
              encodeURIComponent,
              Date: { now: () => clock.now },
              setTimeout: (f: () => void, ms: number) => {
                timers.push({ id: nextId, at: clock.now + ms, f });
                return nextId++;
              },
              clearTimeout: (id: number) => {
                timers = timers.filter((t) => t.id !== id);
              },
            });
            /** Let `ms` pass, firing the timers that fall due, in order. */
            const advance = async (ms: number) => {
              const end = clock.now + ms;
              for (;;) {
                const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers = timers.filter((t) => t !== due);
                clock.now = Math.max(clock.now, due.at);
                due.f();
                await flush();
              }
              clock.now = end;
            };
            const pickTelegram = async () => {
              chips[1].listeners.click({ currentTarget: chips[1] });
              await flush();
            };
            const requests = (path: string) =>
              fetch.mock.calls.filter((c) => c[0] === path).map((c) => JSON.parse((c[1] as { body: string }).body));
            return { nodes, chips, fetch, open, document, window, documentListeners, windowListeners, answers, advance, pickTelegram, requests };
          };
          const STATUS = '/auth/first-app/telegram/status';

          it('stays out of the way until Telegram is picked', async () => {
            const t = await run();
            expect(t.nodes['quick-apps'].hidden).toBe(false);
            expect(t.nodes['tg-setup'].hidden).toBe(true);
            await t.advance(10_000);
            expect(t.fetch).not.toHaveBeenCalled();

            // Another app never shows it.
            t.chips[2].listeners.click({ currentTarget: t.chips[2] });
            await flush();
            expect(t.nodes['tg-setup'].hidden).toBe(true);
          });

          it('shows the button with the link and the QR code once Telegram is picked', async () => {
            const t = await run();
            await t.pickTelegram();

            expect(t.nodes['tg-setup'].hidden).toBe(false);
            expect(t.nodes['tg-create'].attrs.href).toBe(LINK);
            expect(t.nodes['tg-qr'].hidden).toBe(false);
            expect(t.nodes['tg-qr-img'].attrs.src).toBe(PICKED.telegram.qr);
            expect(t.nodes['tg-status'].textContent).toBe('Waiting for your bot…');
            expect(t.nodes['quick-status'].textContent).toBe('Telegram added. Create its bot now, or continue and finish it in Claude.');
            expect(t.nodes['quick-apps'].attrs['data-telegram']).toBe('on');
            // The second link is ready, and not shown yet.
            expect(t.nodes['tg-link'].hidden).toBe(true);
            expect(t.nodes['tg-link-btn'].attrs.href).toBe(CLAIM);
            expect(t.nodes['tg-link-qr'].hidden).toBe(true);
            // Everything stays optional: the request for the chat is still there.
            expect(t.nodes['example-request'].textContent).toBe('Finish setting up my Telegram connector.');
          });

          it('keeps the QR code hidden on a touch device, whatever its user agent says', async () => {
            const t = await run({ touch: true });
            await t.pickTelegram();
            expect(t.nodes['tg-setup'].hidden).toBe(false);
            expect(t.nodes['tg-qr'].hidden).toBe(true);
            expect(t.nodes['tg-qr-img'].attrs.src).toBeUndefined();
          });

          it('has no QR code at all on a phone', async () => {
            const t = await run({ userAgent: PHONE_UA, touch: true });
            expect(t.nodes['tg-qr']).toBeUndefined();
            await t.pickTelegram();
            expect(t.nodes['tg-setup'].hidden).toBe(false);
            expect(t.nodes['tg-create'].attrs.href).toBe(LINK);
          });

          it('asks for the status every two seconds, with the CSRF token', async () => {
            const t = await run();
            await t.pickTelegram();
            expect(t.requests(STATUS)).toHaveLength(0);
            await t.advance(1_900);
            expect(t.requests(STATUS)).toHaveLength(0);
            await t.advance(200);
            expect(t.requests(STATUS)).toEqual([{ csrf: t.nodes['quick-apps'].attrs['data-csrf'] }]);
            expect(t.fetch).toHaveBeenLastCalledWith(STATUS, expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
            await t.advance(6_000);
            expect(t.requests(STATUS)).toHaveLength(4);
          });

          it('does not ask while the page is in the background, and asks at once on coming back', async () => {
            const t = await run();
            await t.pickTelegram();
            t.document.hidden = true;
            await t.advance(20_000);
            expect(t.requests(STATUS)).toHaveLength(0);

            // Back from Telegram: no waiting for the next tick.
            t.document.hidden = false;
            t.documentListeners.visibilitychange();
            await flush();
            expect(t.requests(STATUS)).toHaveLength(1);
            t.windowListeners.focus();
            await flush();
            expect(t.requests(STATUS)).toHaveLength(2);
            // And the two-second rhythm goes on from there.
            await t.advance(2_100);
            expect(t.requests(STATUS)).toHaveLength(3);
          });

          it('shows the connected bot, changes the example request and stops asking', async () => {
            const t = await run();
            await t.pickTelegram();
            t.answers.status = () => ({ ok: true, state: 'connected', bot: '@amcp_1a2b3c4d_bot', request: 'Send me a test message on Telegram.' });
            await t.advance(2_100);

            expect(t.nodes['tg-status'].textContent).toBe('Telegram is connected: @amcp_1a2b3c4d_bot.');
            expect(t.nodes['example-request'].textContent).toBe('Send me a test message on Telegram.');
            // The opening lines said the workspace has no apps: no longer true.
            expect(t.nodes['first-sub'].textContent).toBe('Telegram is ready. Continue to Claude and ask, for example:');
            expect(t.nodes['first-body'].hidden).toBe(true);
            expect(t.nodes['tg-setup'].attrs['data-state']).toBe('connected');
            expect(t.nodes['tg-create'].hidden).toBe(true);
            expect(t.nodes['tg-qr'].hidden).toBe(true);
            expect(t.nodes['tg-paste'].hidden).toBe(true);
            expect(t.nodes['tg-link'].hidden).toBe(true);
            expect(t.nodes['quick-status'].textContent).toBe('');
            // One step is left, and the page says which.
            expect(t.nodes['tg-next'].hidden).toBe(false);
            expect(t.nodes['tg-next'].textContent).toBe('Last step: tap Continue to Claude below.');
            expect(t.nodes['quick-apps'].attrs['data-telegram']).toBe('done');

            const asked = t.requests(STATUS).length;
            await t.advance(60_000);
            expect(t.requests(STATUS)).toHaveLength(asked);
          });

          it('brings Continue into view once the bot is connected, and never follows it for the user', async () => {
            const t = await run();
            const scrolled: unknown[] = [];
            (t.nodes.continue as any).scrollIntoView = (how: unknown) => scrolled.push(how);
            (t.nodes.continue as any).click = jest.fn();
            const before = t.nodes.continue.listeners.click;
            await t.pickTelegram();
            expect(scrolled).toEqual([]);
            t.answers.status = () => ({ ok: true, state: 'connected', bot: '@amcp_1a2b3c4d_bot', request: 'Send me a test message on Telegram.' });
            await t.advance(2_100);

            // Only as far as needed, and once: a later answer does not move the page again.
            expect(scrolled).toEqual([{ block: 'nearest', behavior: 'smooth' }]);
            t.windowListeners.focus();
            await flush();
            await t.advance(10_000);
            expect(scrolled).toHaveLength(1);
            // The tap stays the user's: nothing clicked, opened or added to Continue.
            expect((t.nodes.continue as any).click).not.toHaveBeenCalled();
            expect(t.open).not.toHaveBeenCalled();
            expect(t.nodes.continue.listeners.click).toBe(before);
            expect(t.nodes.continue.attrs).toEqual({ 'data-client': 'Claude', 'data-open-chat': 'https://claude.ai/new' });
          });

          it('still shows the bot as connected in a browser that cannot scroll that way', async () => {
            const t = await run();
            (t.nodes.continue as any).scrollIntoView = () => {
              throw new TypeError('options are not supported');
            };
            await t.pickTelegram();
            t.answers.status = () => ({ ok: true, state: 'connected', bot: '@b_bot', request: 'Send me a test message on Telegram.' });
            await t.advance(2_100);
            expect(t.nodes['tg-status'].textContent).toBe('Telegram is connected: @b_bot.');
            expect(t.nodes['tg-next'].textContent).toBe('Last step: tap Continue to Claude below.');
          });

          it('points to the bot\'s chat until Start was pressed there, then is done', async () => {
            const t = await run();
            await t.pickTelegram();
            const connected = { ok: true, state: 'connected', bot: '@amcp_1a2b3c4d_bot', request: 'Send me a test message on Telegram.' };
            t.answers.status = () => ({ ...connected, startUrl: 'https://t.me/amcp_1a2b3c4d_bot' });
            await t.advance(2_100);

            expect(t.nodes['tg-status'].textContent).toBe('Telegram is connected: @amcp_1a2b3c4d_bot.');
            expect(t.nodes['tg-setup'].attrs['data-state']).toBe('start');
            expect(t.nodes['tg-create'].hidden).toBe(false);
            expect(t.nodes['tg-create'].attrs.href).toBe('https://t.me/amcp_1a2b3c4d_bot');
            expect(t.nodes['tg-create'].textContent).toBe('Open your bot and press Start');
            // Two things are left, in their order; Continue is not pointed at yet.
            expect(t.nodes['tg-next'].hidden).toBe(false);
            expect(t.nodes['tg-next'].textContent).toBe('Two steps left: press Start in your bot’s chat, then tap Continue to Claude below.');
            expect(t.nodes['quick-apps'].attrs['data-telegram']).toBe('on');

            // Still asking: the server greets the user after their first /start.
            const asked = t.requests(STATUS).length;
            await t.advance(4_000);
            expect(t.requests(STATUS).length).toBeGreaterThan(asked);

            t.answers.status = () => connected;
            await t.advance(2_100);
            expect(t.nodes['tg-create'].hidden).toBe(true);
            expect(t.nodes['tg-setup'].attrs['data-state']).toBe('connected');
            expect(t.nodes['tg-next'].textContent).toBe('Last step: tap Continue to Claude below.');
            expect(t.nodes['quick-apps'].attrs['data-telegram']).toBe('done');
            const done = t.requests(STATUS).length;
            await t.advance(30_000);
            expect(t.requests(STATUS)).toHaveLength(done);
          });

          it('stops asking two minutes after connecting when Start is never pressed', async () => {
            const t = await run();
            await t.pickTelegram();
            t.answers.status = () => ({ ok: true, state: 'connected', bot: '@b_bot', startUrl: 'https://t.me/b_bot', request: 'x' });
            await t.advance(125_000);
            const asked = t.requests(STATUS).length;
            await t.advance(60_000);
            expect(t.requests(STATUS)).toHaveLength(asked);
          });

          describe('a bot whose username was changed', () => {
            it('offers "Link your bot" a minute after the pick when the link was never clicked (the QR code)', async () => {
              const t = await run();
              await t.pickTelegram();
              await t.advance(58_000);
              expect(t.nodes['tg-link'].hidden).toBe(true);
              await t.advance(4_000);
              expect(t.nodes['tg-link'].hidden).toBe(false);
              // On a desktop also as a QR code: the bot was made on the phone.
              expect(t.nodes['tg-link-qr'].hidden).toBe(false);
              expect(t.nodes['tg-link-qr-img'].attrs.src).toBe(PICKED.telegram.claimQr);
              // The first QR code and the token option are still there.
              expect(t.nodes['tg-qr'].hidden).toBe(false);
              expect(t.nodes['tg-paste'].hidden).toBe(false);
            });

            it('offers it 20 seconds after the click on the link, and reports that click once', async () => {
              const t = await run();
              await t.pickTelegram();
              await t.advance(50_000);
              const before = t.requests(STATUS).length;

              t.nodes['tg-create'].listeners.click();
              await flush();
              // Sent at once, with the click.
              expect(t.requests(STATUS)).toHaveLength(before + 1);
              expect(t.requests(STATUS)[before]).toEqual({ csrf: expect.any(String), opened: true });

              // The click counts the wait anew: a bot with the suggested username arrives within seconds.
              await t.advance(18_000);
              expect(t.nodes['tg-link'].hidden).toBe(true);
              await t.advance(4_000);
              expect(t.nodes['tg-link'].hidden).toBe(false);
              expect(t.requests(STATUS).filter((body) => body.opened)).toHaveLength(1);
              // The click opens nothing itself: the link does.
              expect(t.open).not.toHaveBeenCalled();
            });

            it('offers it at once when the server saw a bot with another username, and reports that once', async () => {
              const t = await run({ userAgent: PHONE_UA, touch: true });
              await t.pickTelegram();
              t.nodes['tg-create'].listeners.click();
              await flush();
              expect(t.nodes['tg-link'].hidden).toBe(true);

              // Back from Telegram, seconds later.
              t.answers.status = () => ({ ok: true, state: 'waiting', unmatched: true });
              await t.advance(2_100);
              expect(t.nodes['tg-link'].hidden).toBe(false);
              expect(t.nodes['tg-link-btn'].attrs.href).toBe(CLAIM);
              expect(t.nodes['tg-link-btn'].attrs.target).toBeUndefined(); // set in the markup, never by the script
              // No QR code on a phone: the button opens the Telegram app.
              expect(t.nodes['tg-link-qr']).toBeUndefined();

              await t.advance(6_000);
              expect(t.requests(STATUS).filter((body) => body.offered)).toEqual([{ csrf: expect.any(String), offered: true }]);
            });

            it('says so again when the report did not arrive', async () => {
              const t = await run();
              await t.pickTelegram();
              t.answers.status = () => ({ ok: true, state: 'waiting', unmatched: true });
              await t.advance(2_100);
              t.answers.status = () => ({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' });
              await t.advance(2_000);
              t.answers.status = () => ({ ok: true, state: 'waiting' });
              await t.advance(6_000);
              expect(t.requests(STATUS).filter((body) => body.offered)).toHaveLength(2);
              // Once shown it stays, whatever the server says next.
              expect(t.nodes['tg-link'].hidden).toBe(false);
            });

            it('keeps its QR code hidden on a touch device, whatever its user agent says', async () => {
              const t = await run({ touch: true });
              await t.pickTelegram();
              t.answers.status = () => ({ ok: true, state: 'waiting', unmatched: true });
              await t.advance(2_100);
              expect(t.nodes['tg-link'].hidden).toBe(false);
              expect(t.nodes['tg-link-qr'].hidden).toBe(true);
              expect(t.nodes['tg-link-qr-img'].attrs.src).toBeUndefined();
            });

            it('asks for the status at once on a click on it, and opens or navigates nothing itself', async () => {
              const t = await run({ userAgent: PHONE_UA, touch: true });
              await t.pickTelegram();
              t.answers.status = () => ({ ok: true, state: 'waiting', unmatched: true });
              await t.advance(2_100);
              const before = t.requests(STATUS).length;

              t.nodes['tg-link-btn'].listeners.click();
              await flush();
              expect(t.requests(STATUS)).toHaveLength(before + 1);
              expect(t.open).not.toHaveBeenCalled();
              // Continue is as it was: no listener, on a phone.
              expect(t.nodes.continue.listeners).toEqual({});

              // Start was pressed in the setup bot's chat: the bot is connected.
              t.answers.status = () => ({ ok: true, state: 'connected', bot: '@my_shop_bot', request: 'Send me a test message on Telegram.' });
              t.documentListeners.visibilitychange();
              await flush();
              expect(t.nodes['tg-status'].textContent).toBe('Telegram is connected: @my_shop_bot.');
              expect(t.nodes['tg-link'].hidden).toBe(true);
              expect(t.nodes['example-request'].textContent).toBe('Send me a test message on Telegram.');
            });

            it('says that the account is linked when Start was pressed before any bot existed', async () => {
              const t = await run();
              await t.pickTelegram();
              t.answers.status = () => ({ ok: true, state: 'waiting', unmatched: true });
              await t.advance(2_100);
              expect(t.nodes['tg-link'].hidden).toBe(false);

              t.answers.status = () => ({ ok: true, state: 'waiting', claimed: true });
              await t.advance(2_100);
              expect(t.nodes['tg-status'].textContent).toBe('Your Telegram account is linked. Now create your bot: any username works.');
              // Nothing left to link: the button to create the bot is what matters now.
              expect(t.nodes['tg-link'].hidden).toBe(true);
              expect(t.nodes['tg-create'].hidden).toBe(false);
              expect(t.nodes['tg-create'].attrs.href).toBe(LINK);
              await t.advance(120_000);
              expect(t.nodes['tg-link'].hidden).toBe(true);

              t.answers.status = () => ({ ok: true, state: 'connected', bot: '@my_shop_bot', request: 'Send me a test message on Telegram.' });
              await t.advance(2_100);
              expect(t.nodes['tg-status'].textContent).toBe('Telegram is connected: @my_shop_bot.');
            });

            it('never shows a link it was not given', async () => {
              const t = await run();
              const picked = PICKED.telegram as { claim?: string };
              const claim = picked.claim;
              delete picked.claim;
              try {
                await t.pickTelegram();
                t.answers.status = () => ({ ok: true, state: 'waiting', unmatched: true });
                await t.advance(70_000);
                expect(t.nodes['tg-link'].hidden).toBe(true);
                expect(t.requests(STATUS).filter((body) => body.offered)).toHaveLength(0);
              } finally {
                picked.claim = claim;
              }
            });
          });

          it('says so and stops when the page has expired', async () => {
            const t = await run();
            await t.pickTelegram();
            t.answers.status = () => ({ ok: false, error: 'This page has expired.' });
            await t.advance(2_100);
            expect(t.nodes['tg-status'].textContent).toBe('This link has expired. Continue, and finish Telegram in Claude.');
            expect(t.nodes['tg-link'].hidden).toBe(true);
            const asked = t.requests(STATUS).length;
            await t.advance(30_000);
            expect(t.requests(STATUS)).toHaveLength(asked);
          });

          it('keeps asking after an answer it cannot read (offline, too many requests)', async () => {
            const t = await run();
            await t.pickTelegram();
            t.answers.status = () => ({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' });
            await t.advance(6_100);
            expect(t.nodes['tg-status'].textContent).toBe('Waiting for your bot…');
            t.answers.status = () => {
              throw new Error('offline');
            };
            await t.advance(4_000);
            t.answers.status = () => ({ ok: true, state: 'connected', bot: '@b_bot', request: 'Send me a test message on Telegram.' });
            await t.advance(2_100);
            expect(t.nodes['tg-status'].textContent).toBe('Telegram is connected: @b_bot.');
          });

          it('gives up after 30 minutes', async () => {
            const t = await run();
            await t.pickTelegram();
            await t.advance(31 * 60_000);
            const asked = t.requests(STATUS).length;
            await t.advance(60_000);
            expect(t.requests(STATUS)).toHaveLength(asked);
          });

          describe('the token of a bot one already has', () => {
            const TOKEN = '8123456789:AAGpastedTokenForTestsOnly0123456789abc';
            const TOKEN_PATH = '/auth/first-app/telegram/token';
            const submit = async (t: Awaited<ReturnType<typeof run>>, value: string) => {
              t.nodes['tg-token'].value = value;
              const event = { preventDefault: jest.fn() };
              t.nodes['tg-token-form'].listeners.submit(event);
              await flush();
              return event;
            };

            it('is saved, and the page shows the bot as connected', async () => {
              const t = await run();
              await t.pickTelegram();
              const event = await submit(t, `  ${TOKEN} `);

              // Never a page load: the form only posts in the background.
              expect(event.preventDefault).toHaveBeenCalled();
              expect(t.requests(TOKEN_PATH)).toEqual([{ csrf: t.nodes['quick-apps'].attrs['data-csrf'], token: TOKEN }]);
              expect(t.nodes['tg-status'].textContent).toBe('Telegram is connected: @my_own_bot.');
              expect(t.nodes['tg-next'].textContent).toBe('Last step: tap Continue to Claude below.');
              expect(t.nodes['example-request'].textContent).toBe('Send me a test message on Telegram.');
              expect(t.nodes['tg-token'].value).toBe('');
              expect(t.nodes['tg-create'].hidden).toBe(true);
              const asked = t.requests(STATUS).length;
              await t.advance(30_000);
              expect(t.requests(STATUS)).toHaveLength(asked);
            });

            it('is checked on the page before anything is sent', async () => {
              const t = await run();
              await t.pickTelegram();
              await submit(t, 'my bot');
              expect(t.requests(TOKEN_PATH)).toHaveLength(0);
              expect(t.nodes['tg-token-status'].textContent).toContain('does not look like a bot token');
            });

            it('shows why it was refused and keeps waiting for the one-tap bot', async () => {
              const t = await run();
              await t.pickTelegram();
              t.answers.token = () => ({ ok: false, error: 'Telegram refused the bot token.' });
              await submit(t, TOKEN);

              expect(t.nodes['tg-token-status'].textContent).toBe('Telegram refused the bot token.');
              expect(t.nodes['tg-token-save'].attrs['aria-disabled']).toBe('false');
              expect(t.nodes['tg-status'].textContent).toBe('Waiting for your bot…');
              expect(t.nodes['tg-token'].value).toBe(TOKEN);
              const asked = t.requests(STATUS).length;
              await t.advance(2_100);
              expect(t.requests(STATUS).length).toBeGreaterThan(asked);
            });
          });

          it('leaves Continue alone: its one listener is the page\'s own, and there is none on a phone', async () => {
            const desktop = await run();
            const before = desktop.nodes.continue.listeners.click;
            await desktop.pickTelegram();
            desktop.nodes['tg-create'].listeners.click();
            await flush();
            await desktop.advance(25_000);
            desktop.nodes['tg-link-btn'].listeners.click();
            await flush();
            await desktop.advance(5_000);
            expect(desktop.nodes['tg-link'].hidden).toBe(false);
            expect(desktop.nodes.continue.listeners.click).toBe(before);
            expect(Object.keys(desktop.nodes.continue.listeners)).toEqual(['click']);
            expect(desktop.open).not.toHaveBeenCalled();
            // Continue still opens the chat with the request, as before.
            desktop.nodes.continue.listeners.click({});
            expect(desktop.open).toHaveBeenCalledTimes(1);
            expect(desktop.open.mock.calls[0][0]).toContain('https://claude.ai/new?q=');

            const phone = await run({ userAgent: PHONE_UA, touch: true });
            await phone.pickTelegram();
            phone.nodes['tg-create'].listeners.click();
            await flush();
            await phone.advance(25_000);
            phone.nodes['tg-link-btn'].listeners.click();
            await flush();
            await phone.advance(5_000);
            expect(phone.nodes['tg-link'].hidden).toBe(false);
            expect(phone.nodes.continue.listeners).toEqual({});
            expect(phone.open).not.toHaveBeenCalled();
          });
        });
      });
    });
  });

  describe('consent page design', () => {
    const DEPLOY = {
      cloud: { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false },
      selfHosted: { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true },
    };
    const make = (deployment: object, p: object = prisma) =>
      new LoginController(
        authService as unknown as AuthService,
        p as unknown as PrismaService,
        config as unknown as ConfigService,
        store as unknown as PrismaOAuthStore,
        sso as unknown as SsoService,
        deployment as any,
        grants as any,
      );
    const session = (redirectUri: string, clientName: string) => {
      store.getOAuthSession.mockResolvedValue({
        sessionId: 's1',
        state: 'x',
        clientId: 'client-abc',
        redirectUri,
        expiresAt: Date.now() + 60_000,
      } as any);
      store.getClient.mockResolvedValue({ client_id: 'client-abc', client_name: clientName } as any);
    };
    const page = async (c: LoginController, req: Partial<Request> = {}) => {
      const res = makeRes();
      await c.showLoginPage(
        undefined as unknown as string,
        undefined as unknown as string,
        makeReq({ cookies: { oauth_session: 's1' }, ...req } as any),
        res,
      );
      return res._sent ?? '';
    };

    it("shows Claude's logo and the directory badge when the code goes back to claude.ai", async () => {
      session('https://claude.ai/api/mcp/auth_callback', 'Claude');
      const html = await page(make(DEPLOY.cloud));
      expect(html).toContain('Connect Claude to AnythingMCP');
      expect(html).toContain('class="tile tile-claude"');
      expect(html).toContain('Listed in Anthropic&#39;s Claude Directory');
      expect(html).toContain('<span class="host">claude.ai</span>');
      expect(html).not.toContain('returns unknown');
    });

    it('trusts the redirect host, not the name a client gave itself', async () => {
      session('https://claude.ai.evil.example/cb', 'Claude');
      const html = await page(make(DEPLOY.cloud));
      expect(html).not.toContain('class="tile tile-claude"');
      expect(html).toContain('class="tile tile-initial"');
      // The unknown destination is shown, highlighted, with the warning.
      expect(html).toContain('class="returns unknown"');
      expect(html).toContain('claude.ai.evil.example');
      expect(html).toContain('Only continue if you started this');
    });

    it("shows each assistant only its own directory badge, both to other clients, and tells the sign-up page who it is", async () => {
      const link = (client: string) => `href="/login?mode=register&amp;redirect=%2Fauth%2Flogin&amp;client=${client}"`;
      const CLAUDE_ONLY = 'Listed in Anthropic&#39;s Claude Directory';
      const CHATGPT_ONLY = 'Listed in OpenAI&#39;s ChatGPT Plugin Directory';
      const BOTH = 'Listed in the Claude and ChatGPT directories';

      session('https://claude.ai/api/mcp/auth_callback', 'Claude');
      let html = await page(make(DEPLOY.cloud));
      expect(html).toContain(CLAUDE_ONLY);
      expect(html).not.toMatch(/ChatGPT Plugin Directory|directories/);
      expect(html).toContain(link('claude'));

      session('https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT');
      html = await page(make(DEPLOY.cloud));
      expect(html).toContain(CHATGPT_ONLY);
      expect(html).toContain('class="verified verified-chatgpt"');
      expect(html).not.toMatch(/Claude Directory|directories/);
      expect(html).toContain(link('chatgpt'));

      // Muse by Meta's domains, or by name while its host is not known yet:
      // neither assistant's listing.
      for (const [uri, name] of [
        ['https://www.meta.ai/oauth/callback', 'Meta AI'],
        ['https://connectors.example.net/cb', 'Muse'],
      ]) {
        session(uri, name);
        html = await page(make(DEPLOY.cloud));
        expect(html).not.toContain('class="verified');
        expect(html).not.toMatch(/Directory|directories|plugin directory/);
        expect(html).toContain(link('muse'));
      }

      // Any other client (Cursor, Copilot, Grok…) sees both, in one pill.
      session('https://grok.com/connectors-oauth-exchange-code/', 'Grok');
      html = await page(make(DEPLOY.cloud));
      expect(html).toContain(BOTH);
      expect(html).not.toContain(CLAUDE_ONLY);
      expect(html).not.toContain(CHATGPT_ONLY);
      expect(html).toContain(link('other'));
    });

    it('shows no directory badge on self-hosted, for any client', async () => {
      for (const [uri, name] of [
        ['https://claude.ai/api/mcp/auth_callback', 'Claude'],
        ['https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT'],
        ['https://grok.com/connectors-oauth-exchange-code/', 'Grok'],
      ]) {
        session(uri, name);
        const html = await page(make(DEPLOY.selfHosted));
        expect(html).not.toContain('class="verified');
        expect(html).not.toMatch(/Directory|directories|plugin directory/);
      }
      session('https://claude.ai/api/mcp/auth_callback', 'Claude');
      expect(await page(make(DEPLOY.selfHosted))).toContain('class="tile tile-claude"');
    });

    it('puts Allow before Cancel in the markup, so Enter never cancels', async () => {
      session('https://chatgpt.com/connector_platform_oauth_redirect', 'ChatGPT');
      const html = await page(make(DEPLOY.cloud));
      expect(html.indexOf('value="approve"')).toBeGreaterThan(0);
      expect(html.indexOf('value="approve"')).toBeLessThan(html.indexOf('value="deny"'));
    });

    it('makes Frankfurt and DPA claims on Cloud only, and shows no star count', async () => {
      session('https://claude.ai/api/mcp/auth_callback', 'Claude');
      const cloudHtml = await page(make(DEPLOY.cloud, prisma));
      expect(cloudHtml).toContain('Hosted in Frankfurt');
      expect(cloudHtml).toContain('GDPR &middot; DPA');
      expect(cloudHtml).toContain('Open source on GitHub');
      expect(cloudHtml).not.toContain('&#9733;');
      const selfHtml = await page(make(DEPLOY.selfHosted, prisma));
      expect(selfHtml).not.toMatch(/Frankfurt|DPA/);
      expect(selfHtml).toContain('AES-256-GCM');
    });

    it('names the requested server only to a signed-in member of its workspace', async () => {
      session('https://claude.ai/api/mcp/auth_callback', 'Claude');
      authService.verifyToken.mockReturnValue({
        sub: 'u1',
        tokenUse: 'dashboard',
        iat: Math.floor(Date.now() / 1000),
      } as any);
      const member = { userId: 'u1' };
      const p = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'u1',
            email: 'a@b.com',
            name: 'A',
            emailVerified: true,
            sessionsValidFrom: null,
            memberships: [{ organizationId: 'org-1' }],
          }),
        },
        mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ name: 'Sales & <ERP>', organizationId: 'org-1' }) },
        organizationMember: { findFirst: jest.fn().mockResolvedValue(member) },
      };
      const req = { cookies: { oauth_session: 's1', amcp_token: 'jwt' }, signedCookies: { mcp_resource: 'srv-1' } };
      const html = await page(make(DEPLOY.cloud, p), req as any);
      expect(html).toContain('Use the tools on <b>Sales &amp; &lt;ERP&gt;</b> that your role allows');
      expect(p.organizationMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'u1', organizationId: 'org-1' }) }),
      );

      p.organizationMember.findFirst.mockResolvedValue(null);
      const outsider = await page(make(DEPLOY.cloud, p), req as any);
      expect(outsider).not.toContain('Sales');
    });

    it('escapes the client name in the tiles and the heading', async () => {
      session('https://x.example/cb', '<svg onload=alert(1)>');
      const html = await page(make(DEPLOY.cloud));
      expect(html).not.toContain('<svg onload');
      expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    });
  });
});
