import { UnauthorizedException } from '@nestjs/common';
import { RecentSignInService } from './recent-sign-in.service';
import { RecentSignInController } from './recent-sign-in.controller';
import { RECENT_SIGN_IN_COOKIE } from './recent-sign-in.util';

describe('RecentSignInService', () => {
  const NOW_S = Math.floor(Date.now() / 1000);
  const cookie = (userId: string, iat = NOW_S) => ({
    signedCookies: { [RECENT_SIGN_IN_COOKIE]: Buffer.from(JSON.stringify({ uid: userId, iat })).toString('base64url') },
  });

  function build(opts: {
    user?: { id: string; email: string; name: string | null; emailVerified: boolean; sessionsValidFrom: Date | null; organizationId?: string | null } | null;
    memberships?: Array<{ organizationId: string }>;
    ssoBlocked?: boolean;
    cloud?: boolean;
  } = {}) {
    const account =
      opts.user === undefined
        ? { id: 'u1', email: 'u@example.com', name: 'U', emailVerified: true, sessionsValidFrom: null, organizationId: 'org-a' }
        : opts.user;
    const prisma = {
      user: { findUnique: jest.fn(async () => account) },
      organizationMember: { findMany: jest.fn(async () => opts.memberships ?? [{ organizationId: 'org-b' }, { organizationId: 'org-a' }]) },
    };
    const authService = { generateToken: jest.fn(() => 'dashboard-token') };
    const organizations = {
      switchOrg: jest.fn(async (userId: string, organizationId: string) => ({
        id: userId, email: 'u@example.com', name: 'U', role: 'ADMIN', organizationId, mcpRoleId: null,
      })),
    };
    const ssoEnforcement = { isPasswordLoginBlocked: jest.fn(async () => opts.ssoBlocked === true) };
    const deployment = { isCloud: () => opts.cloud !== false };
    const service = new RecentSignInService(prisma as any, authService as any, organizations as any, ssoEnforcement as any, deployment as any);
    return { service, organizations, authService };
  }

  it('knows the user of a valid recent sign-in', async () => {
    const { service } = build();
    await expect(service.user(cookie('u1') as any)).resolves.toEqual({ id: 'u1', email: 'u@example.com', name: 'U' });
  });

  it('knows nobody without the cookie, after "sign out everywhere", unverified on Cloud, or when SSO is required', async () => {
    await expect(build().service.user({ signedCookies: {} } as any)).resolves.toBeNull();
    const revoked = build({ user: { id: 'u1', email: 'e', name: null, emailVerified: true, sessionsValidFrom: new Date((NOW_S + 60) * 1000) } });
    await expect(revoked.service.user(cookie('u1') as any)).resolves.toBeNull();
    const unverified = build({ user: { id: 'u1', email: 'e', name: null, emailVerified: false, sessionsValidFrom: null } });
    await expect(unverified.service.user(cookie('u1') as any)).resolves.toBeNull();
    await expect(build({ ssoBlocked: true }).service.user(cookie('u1') as any)).resolves.toBeNull();
    await expect(build({ user: null }).service.user(cookie('u1') as any)).resolves.toBeNull();
  });

  it('opens a session on the workspace asked for, or on the one last used', async () => {
    const asked = build();
    await asked.service.session('u1', 'org-x');
    expect(asked.organizations.switchOrg).toHaveBeenCalledWith('u1', 'org-x');

    const last = build();
    const out = await last.service.session('u1');
    expect(last.organizations.switchOrg).toHaveBeenCalledWith('u1', 'org-a');
    expect(out?.accessToken).toBe('dashboard-token');
    expect(last.authService.generateToken).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u1', organizationId: 'org-a' }));
  });

  it('falls back to an active workspace, and opens nothing without one', async () => {
    const gone = build({ memberships: [{ organizationId: 'org-b' }] });
    await gone.service.session('u1');
    expect(gone.organizations.switchOrg).toHaveBeenCalledWith('u1', 'org-b');
    await expect(build({ memberships: [] }).service.session('u1')).resolves.toBeNull();
  });
});

describe('RecentSignInController', () => {
  function res() {
    const r: any = { statusCode: 200, body: undefined, cleared: [] as unknown[] };
    r.status = (code: number) => ((r.statusCode = code), r);
    r.end = () => r;
    r.json = (b: unknown) => ((r.body = b), r);
    r.clearCookie = (...args: unknown[]) => r.cleared.push(args);
    return r;
  }

  it('says who, without a token', async () => {
    const recent = { user: jest.fn(async () => ({ id: 'u1', email: 'u@example.com', name: 'U' })), session: jest.fn() };
    const r = res();
    await new RecentSignInController(recent as any).who({} as any, r);
    expect(r.body).toEqual({ email: 'u@example.com', name: 'U' });
    expect(recent.session).not.toHaveBeenCalled();

    const none = res();
    await new RecentSignInController({ user: jest.fn(async () => null) } as any).who({} as any, none);
    expect(none.statusCode).toBe(204);
  });

  it('continues into a session, or refuses', async () => {
    const session = { accessToken: 't', user: { id: 'u1' } };
    const ok = new RecentSignInController({ user: jest.fn(async () => ({ id: 'u1' })), session: jest.fn(async () => session) } as any);
    await expect(ok.continue({} as any)).resolves.toBe(session);

    const no = new RecentSignInController({ user: jest.fn(async () => null), session: jest.fn() } as any);
    await expect(no.continue({} as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forgets the recent sign-in on sign-out', () => {
    const r = res();
    new RecentSignInController({} as any).forget(r);
    expect(r.cleared).toEqual([[RECENT_SIGN_IN_COOKIE, { path: '/' }]]);
  });
});
