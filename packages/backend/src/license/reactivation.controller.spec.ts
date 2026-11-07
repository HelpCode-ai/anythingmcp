import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ReactivationCheckoutDto, ReactivationController } from './reactivation.controller';
import { createReactivationToken } from './reactivation-token';

const KEY = 'reactivation-controller-spec-key-0123456789';
const DAY = 86_400_000;

function license(plan: string, opts: { status?: string; expiresAt?: Date | null } = {}) {
  return {
    licenseKey: 'AMCP-AAAA-BBBB-CCCC-DDDD',
    plan,
    status: opts.status ?? 'active',
    features: null,
    expiresAt: opts.expiresAt === undefined ? null : opts.expiresAt,
    lastVerifiedAt: null,
    instanceId: null,
  };
}

interface MakeOpts {
  cloud?: boolean;
  org?: { name: string } | null;
  current?: any;
  failed?: any;
  lastInactive?: any;
  client?: string | null;
  seenToday?: boolean;
  tokenMember?: any;
  firstAdmin?: any;
  checkout?: () => Promise<any>;
}

function make(opts: MakeOpts = {}) {
  const prisma = {
    organization: {
      findUnique: jest.fn().mockResolvedValue(opts.org === undefined ? { name: 'Acme', id: 'org-1' } : opts.org),
    },
    organizationMember: {
      findUnique: jest.fn().mockResolvedValue(opts.tokenMember ?? null),
      findFirst: jest.fn().mockResolvedValue(
        opts.firstAdmin === undefined ? { userId: 'admin-1', user: { email: 'first-admin@example.com' } } : opts.firstAdmin,
      ),
    },
    productEvent: { findFirst: jest.fn().mockResolvedValue(opts.seenToday ? { id: 'e1' } : null) },
  };
  const licenseService = {
    getCurrentLicense: jest.fn().mockResolvedValue(opts.current ?? null),
    getPaymentFailedLicense: jest.fn().mockResolvedValue(opts.failed ?? null),
    getLatestInactiveLicense: jest.fn().mockResolvedValue(opts.lastInactive ?? null),
    createCheckoutIntent: jest.fn<Promise<any>, [any]>(
      opts.checkout ?? (async () => ({ url: 'https://checkout.stripe.test/s1', trial: false })),
    ),
  };
  const licenseGuard = {
    getUsage: jest.fn().mockResolvedValue({
      plan: null,
      connectors: { current: 3, max: 5, isOver: false },
      mcpServers: { current: 1, max: 1, isOver: false },
      users: { current: 2, max: 1, isOver: true },
      isOverAny: true,
    }),
  };
  const productEvents = { log: jest.fn().mockResolvedValue(undefined) };
  const licenseWall = { connectedClient: jest.fn().mockResolvedValue(opts.client ?? null) };
  const controller = new ReactivationController(
    prisma as any,
    { isCloud: () => opts.cloud ?? true } as any,
    licenseService as any,
    licenseGuard as any,
    productEvents as any,
    licenseWall as any,
  );
  return { controller, prisma, licenseService, licenseGuard, productEvents, licenseWall };
}

describe('ReactivationController', () => {
  const saved = { ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, FRONTEND_URL: process.env.FRONTEND_URL };
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
    process.env.FRONTEND_URL = 'https://cloud.test';
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = saved.ENCRYPTION_KEY;
    process.env.FRONTEND_URL = saved.FRONTEND_URL;
  });
  const token = (userId: string | null = 'user-1') => createReactivationToken({ organizationId: 'org-1', userId })!;
  const ended = new Date(Date.now() - 2 * DAY);

  describe('GET /api/license/reactivate/:token', () => {
    it('shows an ended trial with the workspace, its client and counts, and nothing private', async () => {
      const { controller, productEvents, licenseGuard } = make({
        current: license('trial', { expiresAt: ended }),
        client: 'Claude',
      });
      const view = await controller.view(token());
      expect(view).toEqual({
        state: 'trial-ended',
        workspaceName: 'Acme',
        trialEndedAt: ended.toISOString(),
        client: 'Claude',
        usage: { connectors: 3, mcpServers: 1, users: 2 },
      });
      expect(licenseGuard.getUsage).toHaveBeenCalledWith(undefined, 'org-1');
      expect(JSON.stringify(view)).not.toMatch(/org-1|user-1|AMCP-|@/);
      expect(productEvents.log).toHaveBeenCalledWith({
        event: 'reactivate_page_viewed',
        organizationId: 'org-1',
        userId: null,
        metadata: { state: 'trial-ended' },
      });
    });

    it('reads an ended trial that is no longer active from the latest inactive licence', async () => {
      const { controller } = make({ lastInactive: { plan: 'trial', status: 'expired', expiresAt: ended } });
      const view = await controller.view(token());
      expect(view.state).toBe('trial-ended');
      expect(view.trialEndedAt).toBe(ended.toISOString());
    });

    it.each([
      ['a paid plan', { current: license('team') }],
      ['a running trial', { current: license('trial', { expiresAt: new Date(Date.now() + 3 * DAY) }) }],
    ])('says active for %s', async (_name, opts) => {
      const { controller, licenseService } = make(opts);
      const view = await controller.view(token());
      expect(view.state).toBe('active');
      expect(view.trialEndedAt).toBeNull();
      expect(licenseService.getPaymentFailedLicense).not.toHaveBeenCalled();
    });

    it('puts a failed payment ahead of the ended trial', async () => {
      const { controller } = make({
        current: license('trial', { expiresAt: ended }),
        failed: license('starter', { status: 'expired' }),
      });
      expect((await controller.view(token())).state).toBe('payment-failed');
    });

    it.each([
      ['no licence ever', {}],
      ['a lapsed paid licence', { lastInactive: { plan: 'team', status: 'expired', expiresAt: ended } }],
    ])('says no-license for %s', async (_name, opts) => {
      const { controller } = make(opts);
      const view = await controller.view(token());
      expect(view.state).toBe('no-license');
      expect(view.trialEndedAt).toBeNull();
    });

    it('names only Claude or ChatGPT', async () => {
      const { controller } = make({ current: license('trial', { expiresAt: ended }), client: 'Cursor' });
      expect((await controller.view(token())).client).toBeNull();
    });

    it('records the view once a UTC day', async () => {
      const { controller, productEvents, prisma } = make({ current: license('trial', { expiresAt: ended }), seenToday: true });
      await controller.view(token());
      expect(prisma.productEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'org-1', event: 'reactivate_page_viewed' }),
        }),
      );
      expect(productEvents.log).not.toHaveBeenCalled();
    });

    it('answers 404 for an invalid or expired token', async () => {
      const { controller, prisma } = make();
      await expect(controller.view('not-a-valid-token-at-all')).rejects.toThrow(NotFoundException);
      const old = createReactivationToken({ organizationId: 'org-1' }, new Date(Date.now() - 31 * DAY))!;
      await expect(controller.view(old)).rejects.toThrow('This link is invalid or has expired.');
      expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    });

    it('answers 404 for a deleted workspace', async () => {
      const { controller } = make({ org: null });
      await expect(controller.view(token())).rejects.toThrow(NotFoundException);
    });

    it('answers 404 on self-hosted, even for a valid token', async () => {
      const { controller, prisma } = make({ cloud: false });
      await expect(controller.view(token())).rejects.toThrow(NotFoundException);
      expect(prisma.organization.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/license/reactivate/:token/checkout', () => {
    const dto = { plan: 'starter' as const, billingPeriod: 'yearly' as const };

    it('opens a pay-now checkout for the token user when they are an admin', async () => {
      const t = token('user-1');
      const { controller, licenseService, prisma, productEvents } = make({
        current: license('trial', { expiresAt: ended }),
        tokenMember: { userId: 'user-1', role: 'ADMIN', deactivatedAt: null, user: { email: 'owner@example.com' } },
      });
      await expect(controller.checkout(t, dto)).resolves.toEqual({ url: 'https://checkout.stripe.test/s1' });
      expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId_organizationId: { userId: 'user-1', organizationId: 'org-1' } } }),
      );
      expect(prisma.organizationMember.findFirst).not.toHaveBeenCalled();
      const payload = licenseService.createCheckoutIntent.mock.calls[0][0];
      expect(payload).toEqual({
        email: 'owner@example.com',
        plan: 'cloud_starter',
        billingPeriod: 'yearly',
        returnUrl: `https://cloud.test/reactivate/${t}?paid=1`,
        organizationId: 'org-1',
        source: 'mcp_reactivate',
      });
      expect(payload).not.toHaveProperty('trialEnd');
      expect(productEvents.log).toHaveBeenCalledWith({
        event: 'checkout_link_created',
        userId: 'user-1',
        organizationId: 'org-1',
        metadata: { via: 'mcp_reactivate', kind: 'pay' },
      });
    });

    it.each([
      ['not an admin', { userId: 'user-1', role: 'EDITOR', deactivatedAt: null, user: { email: 'editor@example.com' } }],
      ['deactivated', { userId: 'user-1', role: 'ADMIN', deactivatedAt: new Date(), user: { email: 'gone@example.com' } }],
      ['no longer a member', null],
    ])('falls back to the longest-standing admin when the token user is %s', async (_name, member) => {
      const { controller, licenseService, prisma } = make({ tokenMember: member });
      await controller.checkout(token('user-1'), dto);
      expect(prisma.organizationMember.findFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', role: 'ADMIN', deactivatedAt: null },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        select: { userId: true, user: { select: { email: true } } },
      });
      expect(licenseService.createCheckoutIntent.mock.calls[0][0].email).toBe('first-admin@example.com');
    });

    it('uses the longest-standing admin for a token without a user', async () => {
      const { controller, licenseService, prisma } = make();
      await controller.checkout(token(null), dto);
      expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
      expect(licenseService.createCheckoutIntent.mock.calls[0][0].email).toBe('first-admin@example.com');
    });

    it('refuses with 409 when the workspace has no administrator', async () => {
      const { controller, licenseService } = make({ firstAdmin: null });
      await expect(controller.checkout(token(null), dto)).rejects.toThrow(/No administrator/);
      expect(licenseService.createCheckoutIntent).not.toHaveBeenCalled();
    });

    it('refuses with 409 when the workspace already pays', async () => {
      const { controller, licenseService } = make({ current: license('team') });
      const err = await controller.checkout(token(), dto).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('This workspace already has a subscription. Change your plan in the billing portal.');
      expect(licenseService.createCheckoutIntent).not.toHaveBeenCalled();
    });

    it('refuses with 409 while a failed payment is pending', async () => {
      const { controller, licenseService } = make({
        current: license('trial', { expiresAt: ended }),
        failed: license('starter', { status: 'expired' }),
      });
      const err = await controller.checkout(token(), dto).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/did not go through/);
      expect(licenseService.createCheckoutIntent).not.toHaveBeenCalled();
    });

    it('answers 502 when the licence site fails', async () => {
      const { controller, productEvents } = make({
        checkout: async () => {
          throw new Error('site down');
        },
      });
      await expect(controller.checkout(token(), dto)).rejects.toThrow(BadGatewayException);
      expect(productEvents.log).not.toHaveBeenCalled();
    });

    it('answers 404 for an invalid token, a deleted workspace and on self-hosted', async () => {
      await expect(make().controller.checkout('x'.repeat(40), dto)).rejects.toThrow(NotFoundException);
      await expect(make({ org: null }).controller.checkout(token(), dto)).rejects.toThrow(NotFoundException);
      const selfHosted = make({ cloud: false });
      await expect(selfHosted.controller.checkout(token(), dto)).rejects.toThrow(NotFoundException);
      expect(selfHosted.licenseService.createCheckoutIntent).not.toHaveBeenCalled();
    });
  });
});

describe('ReactivationCheckoutDto', () => {
  const errors = (body: unknown) => validateSync(plainToInstance(ReactivationCheckoutDto, body)).length;

  it('accepts the plans and periods of CheckoutLinkDto only', () => {
    expect(errors({ plan: 'team', billingPeriod: 'monthly' })).toBe(0);
    expect(errors({ plan: 'business', billingPeriod: 'monthly' })).toBeGreaterThan(0);
    expect(errors({ plan: 'starter', billingPeriod: 'weekly' })).toBeGreaterThan(0);
    expect(errors({})).toBeGreaterThan(0);
  });
});
