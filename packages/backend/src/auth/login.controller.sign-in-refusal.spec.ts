// `openid-client` is ESM-only; nothing here exercises the network half.
jest.mock('openid-client', () => ({}));

import * as bcrypt from 'bcrypt';
import { LoginController } from './login.controller';
import { followPausedPageInPlace } from './paused-page.spec-helper';
import type { Request, Response } from 'express';

// The page after approving is reached through a redirect: follow it in place.
followPausedPageInPlace();

/**
 * An e-mail and password that do not sign in get one answer, whatever the
 * reason, after one password check: the text and the time say nothing about
 * the address.
 */

function makeRes() {
  const res: any = {
    _set: [] as string[],
    cookie(name: string) {
      this._set.push(name);
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
      // Express: redirect(url) or redirect(status, url).
      this._redirect = typeof a === 'number' ? (b as string) : a;
      return this;
    },
  };
  return res as Response & Record<string, any>;
}

const CLOUD = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false };
const SELF_HOSTED = { mode: 'self-hosted', isCloud: () => false, isSelfHosted: () => true };
const THREE = [
  { id: 'google', name: 'Google' },
  { id: 'microsoft', name: 'Microsoft' },
  { id: 'github', name: 'GitHub' },
];

function makeController(deployment: typeof CLOUD, providers: { id: string; name: string }[] = THREE) {
  const auth = { comparePassword: jest.fn(async () => false), verifyToken: jest.fn(() => { throw new Error('no'); }) };
  const prisma = { user: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } };
  const controller = new LoginController(
    auth as any,
    prisma as any,
    { get: jest.fn(() => undefined) } as any,
    { getOAuthSession: jest.fn(async () => undefined), getClient: jest.fn() } as any,
    { startMcp: jest.fn() } as any,
    deployment as any,
    { grantServers: jest.fn(), grantWholeOrganization: jest.fn(), listSelectableTargets: jest.fn() } as any,
    undefined,
    undefined,
    undefined,
    { enabledProviders: jest.fn(() => providers), start: jest.fn() } as any,
  );
  return { controller, auth, prisma };
}

const ACCOUNTS: Record<string, unknown[]> = {
  'no account with that address': [],
  'an account made with a provider, which has no password': [
    { id: 'u1', email: 'a@b.com', name: 'A', passwordHash: null, emailVerified: true },
  ],
  'a wrong password': [{ id: 'u2', email: 'a@b.com', name: 'A', passwordHash: '$2b$12$the-accounts-own-hash', emailVerified: true }],
};

async function signIn(deployment: typeof CLOUD, rows: unknown[], providers?: { id: string; name: string }[]) {
  const { controller, auth, prisma } = makeController(deployment, providers);
  prisma.user.findMany.mockResolvedValue(rows);
  const res = makeRes();
  await controller.handleLogin(
    { headers: {}, cookies: { oauth_session: 's1' }, signedCookies: { login_csrf: 'tok' }, secure: false } as unknown as Request,
    { email: 'a@b.com', password: 'not-the-password', csrf: 'tok', action: 'approve' },
    res,
  );
  return { res, auth };
}

describe('LoginController: an e-mail and password that do not sign in', () => {
  it('answers with the same address and text in every case (Cloud)', async () => {
    const answers = new Set<string>();
    for (const rows of Object.values(ACCOUNTS)) {
      const { res } = await signIn(CLOUD, rows);
      answers.add(res._redirect as string);
    }
    expect([...answers]).toEqual([
      `/auth/login?error=${encodeURIComponent(
        'That email and password do not match. If you signed up with Google, Microsoft or GitHub, use that button instead. New here? Create an account first.',
      )}`,
    ]);
    // Nothing of the address typed is in the answer.
    expect([...answers][0]).not.toContain('a%40b.com');
    expect([...answers][0]).not.toContain('a@b.com');
  });

  it.each([
    [[{ id: 'google', name: 'Google' }], 'If you signed up with Google, use that button instead.'],
    [THREE.slice(0, 2), 'If you signed up with Google or Microsoft, use that button instead.'],
  ])('names only the provider buttons the page has', async (providers, sentence) => {
    for (const rows of Object.values(ACCOUNTS)) {
      const { res } = await signIn(CLOUD, rows, providers);
      expect(decodeURIComponent(res._redirect as string)).toBe(
        `/auth/login?error=That email and password do not match. ${sentence} New here? Create an account first.`,
      );
    }
  });

  it('keeps the short answer where there are no provider buttons, again the same in every case', async () => {
    for (const [deployment, providers] of [
      [SELF_HOSTED, THREE],
      [CLOUD, []],
    ] as const) {
      for (const rows of Object.values(ACCOUNTS)) {
        const { res } = await signIn(deployment, rows, [...providers]);
        expect(res._redirect).toBe(`/auth/login?error=${encodeURIComponent('Invalid email or password')}`);
      }
    }
  });

  it.each(Object.entries(ACCOUNTS))('spends exactly one password check on %s', async (_what, rows) => {
    const { auth } = await signIn(CLOUD, rows);
    expect(auth.comparePassword).toHaveBeenCalledTimes(1);
    const [password, hash] = (auth.comparePassword.mock.calls[0] as unknown) as [string, string];
    expect(password).toBe('not-the-password');
    // A bcrypt hash of the cost real accounts have, so the check takes as long.
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('checks against a hash of its own, not an account\'s, when there is no password to check', async () => {
    const noAccount = (await signIn(CLOUD, ACCOUNTS['no account with that address'])).auth.comparePassword.mock.calls[0] as unknown as [string, string];
    const noPassword = (await signIn(CLOUD, ACCOUNTS['an account made with a provider, which has no password'])).auth.comparePassword.mock
      .calls[0] as unknown as [string, string];
    expect(noAccount[1]).toBe(noPassword[1]);
    expect(noAccount[1]).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
    // No password signs in against it, the usual guesses included.
    for (const guess of ['', 'password', 'not-the-password', noAccount[1]]) {
      await expect(bcrypt.compare(guess, noAccount[1])).resolves.toBe(false);
    }
  });

  it('refuses the same way when that check fails, or even says yes', async () => {
    for (const outcome of [async () => { throw new Error('bcrypt is unavailable'); }, async () => true]) {
      for (const rows of [ACCOUNTS['no account with that address'], ACCOUNTS['an account made with a provider, which has no password']]) {
        const { controller, auth, prisma } = makeController(SELF_HOSTED);
        auth.comparePassword.mockImplementation(outcome as any);
        prisma.user.findMany.mockResolvedValue(rows);
        const res = makeRes();
        await controller.handleLogin(
          { headers: {}, cookies: {}, signedCookies: { login_csrf: 'tok' }, secure: false } as unknown as Request,
          { email: 'a@b.com', password: 'pw', csrf: 'tok', action: 'approve' },
          res,
        );
        expect(res._redirect).toBe(`/auth/login?error=${encodeURIComponent('Invalid email or password')}`);
        // No sign-in cookie: the callback has nothing to issue a code for.
        expect(res._set).not.toContain('login_user');
      }
    }
  });
});
