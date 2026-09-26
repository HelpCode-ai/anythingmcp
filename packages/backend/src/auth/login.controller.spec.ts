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
  let prisma: { user: { findUnique: jest.Mock } };
  let config: jest.Mocked<Pick<ConfigService, 'get'>>;
  let store: jest.Mocked<
    Pick<PrismaOAuthStore, 'getOAuthSession' | 'getClient'>
  >;

  let sso: { startMcp: jest.Mock };
  let grants: {
    grantServers: jest.Mock;
    grantWholeOrganization: jest.Mock;
    listSelectableTargets: jest.Mock;
  };

  beforeEach(() => {
    authService = {
      comparePassword: jest.fn(),
      verifyToken: jest.fn((_token: string): any => {
        throw new Error('invalid');
      }),
    };
    prisma = { user: { findUnique: jest.fn() } };
    config = { get: jest.fn().mockReturnValue(undefined) };
    store = { getOAuthSession: jest.fn(), getClient: jest.fn() };
    sso = { startMcp: jest.fn() };
    grants = {
      grantServers: jest.fn().mockResolvedValue([]),
      grantWholeOrganization: jest.fn().mockResolvedValue(true),
      listSelectableTargets: jest.fn().mockResolvedValue([]),
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
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        name: 'A',
        passwordHash: 'hash',
      });
      authService.comparePassword.mockResolvedValue(true);

      const res = makeRes();
      await controller.handleLogin(
        okReq(),
        { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' },
        res,
      );

      expect(res._cookies['login_user']).toBeDefined();
      expect(res._cookies['login_user'].options.signed).toBe(true);
      expect(res._cleared).toContain('login_csrf');
      expect(res._redirect).toBe('http://mcp.test/callback');
    });

    it('redirects with an error on wrong password (no login_user set)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        passwordHash: 'hash',
      });
      authService.comparePassword.mockResolvedValue(false);

      const res = makeRes();
      await controller.handleLogin(
        okReq(),
        { email: 'a@b.com', password: 'bad', csrf: 'tok', action: 'approve' },
        res,
      );

      expect(res._cookies['login_user']).toBeUndefined();
      expect(res._redirect).toContain('/auth/login?error=');
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
      expect(res._sent).toContain('Use a different account');
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
});
