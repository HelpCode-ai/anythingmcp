import { GoneException, UnauthorizedException } from '@nestjs/common';
import { SetupLinksController } from './setup-links.controller';
import { RECENT_SIGN_IN_COOKIE } from '../auth/recent-sign-in.util';

describe('SetupLinksController', () => {
  const NOW_S = Math.floor(Date.now() / 1000);

  function signIn(userId: string, iat = NOW_S) {
    return Buffer.from(JSON.stringify({ uid: userId, iat })).toString('base64url');
  }

  function build(opts: {
    link?: { redirect: string; organizationId: string } | { error: string };
    user?: { id: string; emailVerified: boolean; sessionsValidFrom: Date | null } | null;
    ssoBlocked?: boolean;
    cloud?: boolean;
  } = {}) {
    const setup = {
      resolveLink: jest.fn(async () =>
        opts.link ?? { redirect: '/connectors/setup/etsy?connector=c1&from=claude', organizationId: 'org-test' },
      ),
    };
    const authService = { generateToken: jest.fn(() => 'new-dashboard-token') };
    const organizations = {
      switchOrg: jest.fn(async (userId: string, organizationId: string) => ({
        id: userId,
        email: 'u@example.com',
        name: 'U',
        role: 'ADMIN',
        organizationId,
        mcpRoleId: null,
      })),
    };
    const ssoEnforcement = { isPasswordLoginBlocked: jest.fn(async () => opts.ssoBlocked === true) };
    const prisma = {
      user: {
        findUnique: jest.fn(async () =>
          opts.user === undefined ? { id: 'u1', emailVerified: true, sessionsValidFrom: null } : opts.user,
        ),
      },
    };
    const deployment = { isCloud: () => opts.cloud !== false };
    const controller = new SetupLinksController(
      setup as any,
      authService as any,
      organizations as any,
      ssoEnforcement as any,
      prisma as any,
      deployment as any,
    );
    return { controller, setup, authService, organizations };
  }

  const withCookie = (value: string | undefined) => ({ signedCookies: value ? { [RECENT_SIGN_IN_COOKIE]: value } : {} }) as any;

  describe('open (no dashboard session)', () => {
    it('opens the link with the sign-in this browser just made, in the link workspace', async () => {
      const { controller, setup, organizations, authService } = build();
      const out = await controller.open(withCookie(signIn('u1')), { token: 'tok', from: 'claude' });

      expect(setup.resolveLink).toHaveBeenCalledWith('tok', 'u1', 'claude');
      expect(organizations.switchOrg).toHaveBeenCalledWith('u1', 'org-test');
      expect(authService.generateToken).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'u1', organizationId: 'org-test' }),
      );
      expect(out).toEqual({
        redirect: '/connectors/setup/etsy?connector=c1&from=claude',
        session: {
          accessToken: 'new-dashboard-token',
          user: { id: 'u1', email: 'u@example.com', name: 'U', role: 'ADMIN', organizationId: 'org-test' },
        },
      });
    });

    it('asks for a sign-in without the cookie, and never opens the link', async () => {
      const { controller, setup } = build();
      await expect(controller.open(withCookie(undefined), { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(setup.resolveLink).not.toHaveBeenCalled();
    });

    it('gives no session for a link made for another account than the one signed in', async () => {
      const { controller, organizations, authService } = build({ link: { error: 'This link was made for another account. Sign in as that account.' } });
      await expect(controller.open(withCookie(signIn('u1')), { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(organizations.switchOrg).not.toHaveBeenCalled();
      expect(authService.generateToken).not.toHaveBeenCalled();
    });

    it('refuses a sign-in made before "sign out everywhere", an unknown user and an unverified e-mail on Cloud', async () => {
      const revoked = build({ user: { id: 'u1', emailVerified: true, sessionsValidFrom: new Date((NOW_S + 60) * 1000) } });
      await expect(revoked.controller.open(withCookie(signIn('u1')), { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);

      const gone = build({ user: null });
      await expect(gone.controller.open(withCookie(signIn('u1')), { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);

      const unverified = build({ user: { id: 'u1', emailVerified: false, sessionsValidFrom: null } });
      await expect(unverified.controller.open(withCookie(signIn('u1')), { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
      for (const b of [revoked, gone, unverified]) expect(b.setup.resolveLink).not.toHaveBeenCalled();
    });

    it('leaves a workspace that requires SSO to its own sign-in', async () => {
      const { controller, setup } = build({ ssoBlocked: true });
      await expect(controller.open(withCookie(signIn('u1')), { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(setup.resolveLink).not.toHaveBeenCalled();
    });
  });

  describe('resolve (dashboard session)', () => {
    it('switches the session to the connector workspace when it is on another one', async () => {
      const { controller, organizations } = build();
      const out = await controller.resolve({ user: { sub: 'u1', organizationId: 'org-main' } }, { token: 'tok' });
      expect(organizations.switchOrg).toHaveBeenCalledWith('u1', 'org-test');
      expect(out.session?.user.organizationId).toBe('org-test');
    });

    it('keeps the session when it is already on that workspace', async () => {
      const { controller, organizations } = build();
      const out = await controller.resolve({ user: { sub: 'u1', organizationId: 'org-test' } }, { token: 'tok' });
      expect(out).toEqual({ redirect: '/connectors/setup/etsy?connector=c1&from=claude' });
      expect(organizations.switchOrg).not.toHaveBeenCalled();
    });

    it('answers an expired or foreign link with its reason', async () => {
      const { controller } = build({ link: { error: 'This link has expired.' } });
      await expect(controller.resolve({ user: { sub: 'u1', organizationId: 'o' } }, { token: 'tok' })).rejects.toBeInstanceOf(GoneException);
    });
  });
});
