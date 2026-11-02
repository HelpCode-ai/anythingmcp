import { GoneException, UnauthorizedException } from '@nestjs/common';
import { SetupLinksController } from './setup-links.controller';

describe('SetupLinksController', () => {
  const DASH = { headers: { 'x-amcp-dashboard': '1' } } as any;
  const SESSION = (organizationId: string) => ({
    accessToken: 'new-dashboard-token',
    user: { id: 'u1', email: 'u@example.com', name: 'U', role: 'ADMIN', organizationId },
  });

  function build(opts: {
    link?: { redirect: string; organizationId: string } | { error: string };
    recentUser?: { id: string; email: string; name: string | null } | null;
  } = {}) {
    const setup = {
      resolveLink: jest.fn(async () =>
        opts.link ?? { redirect: '/connectors/setup/etsy?connector=c1&from=claude', organizationId: 'org-test' },
      ),
    };
    const recent = {
      user: jest.fn(async () => (opts.recentUser === undefined ? { id: 'u1', email: 'u@example.com', name: 'U' } : opts.recentUser)),
      session: jest.fn(async (_userId: string, organizationId: string) => SESSION(organizationId)),
    };
    const controller = new SetupLinksController(setup as any, recent as any);
    return { controller, setup, recent };
  }

  describe('open (no dashboard session)', () => {
    it('opens the link with the sign-in this browser just made, in the link workspace', async () => {
      const { controller, setup, recent } = build();
      const out = await controller.open(DASH, { token: 'tok', from: 'claude' });

      expect(setup.resolveLink).toHaveBeenCalledWith('tok', 'u1', 'claude');
      expect(recent.session).toHaveBeenCalledWith('u1', 'org-test');
      expect(out).toEqual({ redirect: '/connectors/setup/etsy?connector=c1&from=claude', session: SESSION('org-test') });
    });

    it('refuses a request without the dashboard header (a blind cross-site POST)', async () => {
      const { controller, setup, recent } = build();
      await expect(controller.open({ headers: {} } as any, { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(recent.user).not.toHaveBeenCalled();
      expect(setup.resolveLink).not.toHaveBeenCalled();
    });

    it('asks for a sign-in without a recent sign-in, and never opens the link', async () => {
      const { controller, setup } = build({ recentUser: null });
      await expect(controller.open(DASH, { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(setup.resolveLink).not.toHaveBeenCalled();
    });

    it('gives no session for a link made for another account than the one signed in', async () => {
      const { controller, recent } = build({ link: { error: 'This link was made for another account. Sign in as that account.' } });
      await expect(controller.open(DASH, { token: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(recent.session).not.toHaveBeenCalled();
    });
  });

  describe('resolve (dashboard session)', () => {
    it('switches the session to the connector workspace when it is on another one', async () => {
      const { controller, recent } = build();
      const out = await controller.resolve({ user: { sub: 'u1', organizationId: 'org-main' } }, { token: 'tok' });
      expect(recent.session).toHaveBeenCalledWith('u1', 'org-test');
      expect(out.session?.user.organizationId).toBe('org-test');
    });

    it('keeps the session when it is already on that workspace', async () => {
      const { controller, recent } = build();
      const out = await controller.resolve({ user: { sub: 'u1', organizationId: 'org-test' } }, { token: 'tok' });
      expect(out).toEqual({ redirect: '/connectors/setup/etsy?connector=c1&from=claude' });
      expect(recent.session).not.toHaveBeenCalled();
    });

    it('answers an expired or foreign link with its reason', async () => {
      const { controller } = build({ link: { error: 'This link has expired.' } });
      await expect(controller.resolve({ user: { sub: 'u1', organizationId: 'o' } }, { token: 'tok' })).rejects.toBeInstanceOf(GoneException);
    });
  });
});
