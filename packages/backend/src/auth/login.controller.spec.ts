import { Logger } from '@nestjs/common';
// `openid-client` is ESM-only and this suite reaches it transitively through
// LoginController -> SsoService. Nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { LoginController } from './login.controller';
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
          /<a href="https:\/\/cloud\.example\/start-trial\?source=post_approve" target="_blank" rel="noopener noreferrer">add a card now \(new tab\)<\/a>/,
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

      const showPage = async (c: LoginController = picking) => {
        const res = makeRes();
        await c.handleLogin(
          makeReq({ cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: 'tok' }, headers: { host: 'mcp.test' } } as any),
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
          ['shopify', 'Shopify'],
          ['woocommerce', 'WooCommerce'],
          ['odoo', 'Odoo'],
          ['printify', 'Printify'],
        ]) {
          expect(page).toContain(`data-adapter="${slug}" data-name="${name}">${name}</button>`);
        }
        // Picked often, set up almost never: it is reached through "Another app".
        expect(page).not.toContain('data-adapter="gemini"');
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
        const run = async (fetchAnswer: () => Promise<unknown>) => {
          arrange();
          const page = (await showPage())._sent as string;
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
            continue: el({ 'data-client': 'Claude', 'data-open-chat': 'https://claude.ai/new' }),
          };
          const fetch = jest.fn(async () => ({ json: async () => fetchAnswer() }));
          const open = jest.fn();
          const window = { fetch, JSON, open };
          require('vm').runInNewContext(script, {
            document: { getElementById: (id: string) => nodes[id] ?? null },
            navigator: {},
            window,
            fetch,
            JSON,
            encodeURIComponent,
          });
          return { nodes, chips, fetch, open };
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
          const { nodes, chips } = await run(async () => ({ ok: false, error: 'Shopify could not be added right now.' }));
          chips[2].listeners.click({ currentTarget: chips[2] });
          await flush();
          await flush();
          expect(nodes['quick-status'].textContent).toBe('Shopify could not be added right now.');
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
        const res = await pick({ adapter: 'shopify', csrf: 'pick-tok' });

        expect(res._json.ok).toBe(true);
        const ctx = expect.objectContaining({ userId: 'u1', organizationId: 'org-2', serverIds: [] });
        expect(provider.canSetUp).toHaveBeenCalledWith(ctx);
        expect(provider.install).toHaveBeenCalledWith(ctx, { adapter: 'shopify' }, { via: 'post_approve' });
        expect(productEvents.log).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'post_approve_app_picked', organizationId: 'org-2' }),
        );
      });

      it('adds the app to the user\'s own workspace when the client has no grant', async () => {
        arrange();
        grants.resolve.mockResolvedValue(null);
        await pick({ adapter: 'shopify', csrf: 'pick-tok' });

        expect(provider.install).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: 'org-1', serverIds: [] }),
          { adapter: 'shopify' },
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
        const res = await pick({ adapter: 'shopify', csrf: 'pick-tok' });

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
        const res = await pick({ adapter: 'shopify', csrf: 'pick-tok' });
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ ok: false, error: expect.stringContaining('You can still continue') });
        expect(productEvents.log).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'post_approve_app_picked',
            metadata: { adapterSlug: 'shopify', client: 'Claude', status: 'failed', error: 'Connector limit reached' },
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

    it('tells the sign-up page a Raycast client is Raycast, with the same badges and tiles as any other client', async () => {
      const link = (client: string) => `href="/login?mode=register&amp;redirect=%2Fauth%2Flogin&amp;client=${client}"`;
      for (const [uri, name] of [
        ['raycast://oauth?package_name=Extension', 'Raycast'],
        ['raycast://oauth?package_name=Extension', 'client-abc'],
        ['https://raycast.com/redirect?packageName=Extension', 'MCP Client'],
      ]) {
        session(uri, name);
        const html = await page(make(DEPLOY.cloud));
        expect(html).toContain(link('raycast'));
        expect(html).toContain('Listed in the Claude and ChatGPT directories');
        expect(html).toContain('class="tile tile-initial"');
        expect(html).toContain('value="approve"');
      }
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
