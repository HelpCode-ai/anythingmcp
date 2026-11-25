// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoginController, loginPostKind, loginPostLimit, loginPostThrottleKey } from './login.controller';
import { followPausedPageInPlace } from './paused-page.spec-helper';

// The page after approving is reached through a redirect: follow it in place.
followPausedPageInPlace();

/**
 * POST /auth/login: password attempts keep their 5 a minute per address; the
 * buttons that check no password are counted on their own.
 */

const PASSWORD = { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' };
const BUTTONS = ['social:google', 'social:github', 'sso:idp-1', 'approve-session', 'deny'];

function contextFor(ip: string, body: unknown): ExecutionContext {
  const req = { ip, body, headers: {} };
  const res = { header: () => undefined };
  return {
    getHandler: () => LoginController.prototype.handleLogin,
    getClass: () => LoginController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('POST /auth/login rate limit', () => {
  describe('which posts are password attempts', () => {
    it.each(BUTTONS)('counts "%s" as a button', (action) => {
      expect(loginPostKind({ action })).toBe('button');
      // What else the form carries does not change that.
      expect(loginPostKind({ action, email: 'a@b.com', password: 'pw' })).toBe('button');
    });

    it.each([
      ['Sign in & allow', { action: 'approve' }],
      ['no action', { email: 'a@b.com', password: 'pw' }],
      ['an unknown action', { action: 'something-else' }],
      ['an action in another case', { action: 'Social:google' }],
      ['an action with a space before it', { action: ' social:google' }],
      ['an action sent as a list', { action: ['social:google'] }],
      ['an action sent as an object', { action: { startsWith: 'social:' } }],
      ['an empty body', {}],
      ['no body', undefined],
      ['a null body', null],
      ['a body that is no object', 'action=social:google'],
    ])('counts %s as a password attempt', (_what, body) => {
      expect(loginPostKind(body)).toBe('password');
    });
  });

  describe('through the throttler guard', () => {
    let guard: ThrottlerGuard;
    let storage: ThrottlerStorageService;

    beforeEach(async () => {
      storage = new ThrottlerStorageService();
      // The application's own throttler (app.module.ts): 100 a minute unless a route says otherwise.
      guard = new ThrottlerGuard([{ ttl: 60_000, limit: 100 }], storage, new Reflector());
      await guard.onModuleInit();
    });

    afterEach(() => storage.onApplicationShutdown());

    const post = (ip: string, body: unknown) => guard.canActivate(contextFor(ip, body));

    it('still stops the sixth password attempt of an address in a minute', async () => {
      for (let i = 0; i < 5; i++) await expect(post('203.0.113.7', PASSWORD)).resolves.toBe(true);
      await expect(post('203.0.113.7', PASSWORD)).rejects.toBeInstanceOf(ThrottlerException);
      // Another address has its own five.
      await expect(post('203.0.113.8', PASSWORD)).resolves.toBe(true);
    });

    it('does not give more password attempts to a caller who also presses buttons', async () => {
      for (let i = 0; i < 5; i++) await post('203.0.113.7', PASSWORD);
      for (const action of BUTTONS) await expect(post('203.0.113.7', { csrf: 'tok', action })).resolves.toBe(true);
      await expect(post('203.0.113.7', PASSWORD)).rejects.toBeInstanceOf(ThrottlerException);
      // Nor to one who changes what the post looks like without making it a button.
      for (const body of [{ ...PASSWORD, action: undefined }, { ...PASSWORD, action: 'x' }, { ...PASSWORD, action: ['deny'] }, undefined]) {
        await expect(post('203.0.113.7', body)).rejects.toBeInstanceOf(ThrottlerException);
      }
    });

    it('no longer lets the buttons use up the password attempts', async () => {
      for (let i = 0; i < 12; i++) await expect(post('203.0.113.7', { csrf: 'tok', action: 'social:google' })).resolves.toBe(true);
      for (let i = 0; i < 5; i++) await expect(post('203.0.113.7', PASSWORD)).resolves.toBe(true);
      await expect(post('203.0.113.7', PASSWORD)).rejects.toBeInstanceOf(ThrottlerException);
    });

    it('limits the buttons too: 30 a minute per address, all of them together', async () => {
      for (let i = 0; i < 30; i++) {
        await expect(post('203.0.113.7', { csrf: 'tok', action: BUTTONS[i % BUTTONS.length] })).resolves.toBe(true);
      }
      for (const action of BUTTONS) {
        await expect(post('203.0.113.7', { csrf: 'tok', action })).rejects.toBeInstanceOf(ThrottlerException);
      }
      await expect(post('203.0.113.8', { csrf: 'tok', action: 'social:google' })).resolves.toBe(true);
    });

    it('counts password attempts under the key the throttler builds by default', () => {
      const context = contextFor('203.0.113.7', PASSWORD);
      const byDefault = (guard as unknown as { generateKey: (c: ExecutionContext, s: string, n: string) => string }).generateKey(
        context,
        '203.0.113.7',
        'default',
      );
      expect(loginPostThrottleKey(context, '203.0.113.7', 'default')).toBe(byDefault);
      expect(loginPostThrottleKey(contextFor('203.0.113.7', { action: 'deny' }), '203.0.113.7', 'default')).not.toBe(byDefault);
      expect(loginPostLimit(context)).toBe(5);
      expect(loginPostLimit(contextFor('203.0.113.7', { action: 'deny' }))).toBe(30);
    });
  });

  describe('a post counted as a button', () => {
    function makeRes() {
      const res: any = {
        _cleared: [] as string[],
        cookie() {
          return this;
        },
        clearCookie(name: string) {
          this._cleared.push(name);
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
        redirect(url: string) {
          this._redirect = url;
          return this;
        },
      };
      return res as Response & Record<string, any>;
    }

    it.each(BUTTONS)('never reaches the account lookup or the password check: %s', async (action) => {
      const auth = { comparePassword: jest.fn(), verifyToken: jest.fn(() => { throw new Error('no'); }) };
      const prisma = { user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } };
      const controller = new LoginController(
        auth as any,
        prisma as any,
        { get: jest.fn(() => undefined) } as any,
        { getOAuthSession: jest.fn(async () => undefined), getClient: jest.fn() } as any,
        { startMcp: jest.fn(async () => ({ authorizationUrl: 'https://idp.example/authorize?x' })) } as any,
        { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false } as any,
        { grantServers: jest.fn(), grantWholeOrganization: jest.fn(), listSelectableTargets: jest.fn() } as any,
        undefined,
        undefined,
        undefined,
        {
          enabledProviders: jest.fn(() => [{ id: 'google', name: 'Google' }]),
          start: jest.fn(async () => ({ authorizationUrl: 'https://accounts.google.com/auth?x', bindingToken: 'bind' })),
        } as any,
      );
      const res = makeRes();
      await controller.handleLogin(
        { headers: {}, cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: 'tok' }, secure: false } as unknown as Request,
        // A full set of credentials next to the button: they are not looked at.
        { email: 'a@b.com', password: 'pw', csrf: 'tok', action } as any,
        res,
      );
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(auth.comparePassword).not.toHaveBeenCalled();
    });
  });
});
