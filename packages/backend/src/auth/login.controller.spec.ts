import { LoginController } from './login.controller';
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
  let authService: jest.Mocked<Pick<AuthService, 'comparePassword'>>;
  let prisma: { user: { findUnique: jest.Mock } };
  let config: jest.Mocked<Pick<ConfigService, 'get'>>;
  let store: jest.Mocked<
    Pick<PrismaOAuthStore, 'getOAuthSession' | 'getClient'>
  >;

  beforeEach(() => {
    authService = { comparePassword: jest.fn() };
    prisma = { user: { findUnique: jest.fn() } };
    config = { get: jest.fn().mockReturnValue(undefined) };
    store = { getOAuthSession: jest.fn(), getClient: jest.fn() };

    controller = new LoginController(
      authService as unknown as AuthService,
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      store as unknown as PrismaOAuthStore,
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

    it('falls back to a generic form (no consent block) without a session', async () => {
      const res = makeRes();
      await controller.showLoginPage(
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
});
