import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LicenseController } from './license.controller';
import { readEmailLinkToken } from '../common/email-link-token';

/**
 * activate-trial used to answer 400 on every single signup.
 *
 * The verification flow activates the trial server-side, then the client calls
 * this endpoint too; the second call found an existing licence and turned the
 * licence API's 409 into a BadRequest. The user's trial was fine, but they were
 * shown an error, and the wasted call ate the licence API's rate budget.
 */
describe('LicenseController — activate-trial is idempotent', () => {
  const user = { id: 'u1', email: 'user@example.com', name: 'User' };
  const req = { user: { sub: 'u1', organizationId: 'org-1' } };

  function makeController(existingLicense: any) {
    const licenseService = {
      getCurrentLicense: jest.fn(async () => existingLicense),
      requestTrialLicense: jest.fn(async () => ({
        licenseKey: 'AMCP-NEW',
        plan: 'trial',
        expiresAt: '2026-10-01T00:00:00.000Z',
        trialDaysLeft: 7,
      })),
    };
    const controller = new LicenseController(
      licenseService as any,
      {} as any,
      {} as any,
      { findById: jest.fn(async () => user) } as any,
      { isCloud: () => true } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, licenseService };
  }

  it('returns the existing licence as a success instead of an error', async () => {
    const expiresAt = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const { controller, licenseService } = makeController({
      licenseKey: 'AMCP-EXISTING',
      plan: 'trial',
      expiresAt,
    });

    const result: any = await controller.activateTrial(req);

    expect(result.trialStarted).toBe(false);
    expect(result.licenseKey).toBe('AMCP-EXISTING');
    expect(result.trialDaysLeft).toBe(3);
    expect(licenseService.requestTrialLicense).not.toHaveBeenCalled();
  });

  it('still starts a real trial when the workspace has none', async () => {
    const { controller, licenseService } = makeController(null);

    const result: any = await controller.activateTrial(req);

    expect(result.trialStarted).toBe(true);
    expect(result.licenseKey).toBe('AMCP-NEW');
    expect(licenseService.requestTrialLicense).toHaveBeenCalledWith(
      'user@example.com',
      'User',
      'org-1',
    );
  });

  it('reports a perpetual licence without pretending it expires today', async () => {
    const { controller } = makeController({
      licenseKey: 'AMCP-PERPETUAL',
      plan: 'enterprise',
      expiresAt: null,
    });

    const result: any = await controller.activateTrial(req);

    expect(result.expiresAt).toBeNull();
    expect(result.trialDaysLeft).toBe(0);
  });
});

/**
 * A Cloud workspace whose trial ran out used to get `plan: null` from
 * /status, the same answer as a workspace that never had a licence. The app
 * then offered "Start 7-Day Free Trial" (which the licence site will not grant
 * twice) instead of "your trial has ended, choose a plan".
 */
describe('LicenseController — status reports an ended licence', () => {
  const req = { headers: { authorization: 'Bearer t' } };

  function makeController(opts: { active?: any; inactive?: any; paymentFailed?: any; cloud?: boolean }) {
    const licenseService = {
      getCurrentLicense: jest.fn(async () => opts.active ?? null),
      getLatestInactiveLicense: jest.fn(async () => opts.inactive ?? null),
      getPaymentFailedLicense: jest.fn(async () => opts.paymentFailed ?? null),
    };
    const controller = new LicenseController(
      licenseService as any,
      {} as any,
      { verifyToken: () => ({ organizationId: 'org-1' }) } as any,
      {} as any,
      { isCloud: () => opts.cloud ?? true } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, licenseService };
  }

  it('reports an expired trial as a trial with no days left, without features', async () => {
    const expiresAt = new Date(Date.now() - 3600_000);
    const { controller } = makeController({ inactive: { plan: 'trial', status: 'expired', expiresAt } });
    const status: any = await controller.getStatus(req);
    expect(status).toMatchObject({ plan: 'trial', status: 'expired', trialDaysLeft: 0, features: null });
  });

  it('reports a lapsed paid licence with its status and no trial countdown', async () => {
    const { controller } = makeController({ inactive: { plan: 'starter', status: 'expired', expiresAt: null } });
    const status: any = await controller.getStatus(req);
    expect(status).toMatchObject({ plan: 'starter', status: 'expired', features: null });
    expect(status.trialDaysLeft).toBeUndefined();
  });

  // A card trial whose first charge was declined: the site revokes the licence
  // while Stripe retries. The app must ask for a new card, not sell a second
  // subscription (duplicates on 13 and 14 Oct 2026).
  const declined = {
    plan: 'starter',
    status: 'revoked',
    expiresAt: null,
    billing: { status: 'past_due', cancelling: false },
  };

  it('reports a licence stopped on a declined card as payment failed, with its billing', async () => {
    const { controller } = makeController({ paymentFailed: declined, inactive: declined });
    const status: any = await controller.getStatus(req);
    expect(status).toMatchObject({
      plan: 'starter',
      status: 'revoked',
      paymentFailed: true,
      features: null,
      billing: { status: 'past_due' },
    });
  });

  it('puts a declined card ahead of the free trial that ran out with it', async () => {
    const endedTrial = { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() - 3600_000) };
    const { controller } = makeController({ active: endedTrial, paymentFailed: declined });
    expect(await controller.getStatus(req)).toMatchObject({ plan: 'starter', paymentFailed: true });
  });

  it('leaves a free trial with days left alone', async () => {
    const trial = { plan: 'trial', status: 'active', expiresAt: new Date(Date.now() + 3 * 86400000) };
    const { controller, licenseService } = makeController({ active: trial, paymentFailed: declined });
    expect(await controller.getStatus(req)).toMatchObject({ plan: 'trial', trialDaysLeft: 3 });
    expect(licenseService.getPaymentFailedLicense).not.toHaveBeenCalled();
  });

  it('still answers "none" for a workspace that never had a licence', async () => {
    const { controller } = makeController({});
    expect(await controller.getStatus(req)).toMatchObject({ plan: null, status: 'none' });
  });

  it('does not look up inactive licences on self-hosted', async () => {
    const { controller, licenseService } = makeController({ cloud: false });
    await controller.getStatus(req);
    expect(licenseService.getLatestInactiveLicense).not.toHaveBeenCalled();
  });
});

describe('LicenseController — pricing-link token', () => {
  const ENV = process.env.EMAIL_LINK_SECRET;
  afterEach(() => {
    if (ENV === undefined) delete process.env.EMAIL_LINK_SECRET;
    else process.env.EMAIL_LINK_SECRET = ENV;
  });

  function make(cloud: boolean) {
    return new LicenseController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { isCloud: () => cloud } as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }
  const req = { user: { sub: 'u1', email: 'Ann@Example.com', organizationId: 'org-1' } };

  it('gives the signed-in user their own address as a token the pricing page reads', () => {
    process.env.EMAIL_LINK_SECRET = 'shared-with-the-licence-site';
    const { token } = make(true).pricingLinkToken(req);
    expect(readEmailLinkToken(token)).toBe('ann@example.com');
  });

  it('gives none without EMAIL_LINK_SECRET, nor on a self-hosted instance', () => {
    delete process.env.EMAIL_LINK_SECRET;
    expect(make(true).pricingLinkToken(req)).toEqual({ token: null });
    process.env.EMAIL_LINK_SECRET = 'shared-with-the-licence-site';
    expect(make(false).pricingLinkToken(req)).toEqual({ token: null });
  });
});

/**
 * The licence site calls POST /api/license/sync from its Stripe webhook when a
 * licence changes, so a plan bought in the billing portal reaches the
 * workspace at once instead of at the next daily re-verification (6 Nov 2026:
 * a Team upgrade stayed on Starter limits on Cloud while the site had it).
 */
describe('LicenseController — the licence site reports a changed licence', () => {
  const OLD = process.env.LICENSE_SERVICE_TOKEN;
  const TOKEN = 'svc-token-0123456789abcdef';
  const KEY = 'AMCP-AAAA-BBBB-CCCC-DDDD';
  afterEach(() => {
    process.env.LICENSE_SERVICE_TOKEN = OLD;
  });

  function make(isCloud = true, syncFromSite = jest.fn(async () => true)) {
    const controller = new LicenseController(
      { syncFromSite } as any,
      {} as any,
      {} as any,
      {} as any,
      { isCloud: () => isCloud } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, syncFromSite };
  }
  const req = (token?: string) => ({ headers: token === undefined ? {} : { 'x-amcp-service-token': token } });

  it('re-verifies the licence when the site presents its service token', async () => {
    process.env.LICENSE_SERVICE_TOKEN = TOKEN;
    const { controller, syncFromSite } = make();
    await expect(controller.syncFromSite(req(TOKEN), { licenseKey: KEY })).resolves.toEqual({ synced: true });
    expect(syncFromSite).toHaveBeenCalledWith(KEY);
  });

  it.each([
    ['no token', undefined],
    ['a wrong token', 'svc-token-0123456789abcdeX'],
    ['a token of another length', 'short'],
  ])('answers 404 to a caller with %s', async (_label, token) => {
    process.env.LICENSE_SERVICE_TOKEN = TOKEN;
    const { controller, syncFromSite } = make();
    await expect(controller.syncFromSite(req(token), { licenseKey: KEY })).rejects.toBeInstanceOf(NotFoundException);
    expect(syncFromSite).not.toHaveBeenCalled();
  });

  it('answers 404 when this server has no service token configured', async () => {
    delete process.env.LICENSE_SERVICE_TOKEN;
    const { controller } = make();
    await expect(controller.syncFromSite(req(''), { licenseKey: KEY })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 on self-hosted', async () => {
    process.env.LICENSE_SERVICE_TOKEN = TOKEN;
    const { controller, syncFromSite } = make(false);
    await expect(controller.syncFromSite(req(TOKEN), { licenseKey: KEY })).rejects.toBeInstanceOf(NotFoundException);
    expect(syncFromSite).not.toHaveBeenCalled();
  });

  it('reports a failed verification without failing the webhook', async () => {
    process.env.LICENSE_SERVICE_TOKEN = TOKEN;
    const { controller } = make(true, jest.fn(async () => { throw new Error('site down'); }));
    await expect(controller.syncFromSite(req(TOKEN), { licenseKey: KEY })).resolves.toEqual({ synced: false });
  });
});

describe('LicenseController — plan fit', () => {
  function make(cloud = true) {
    const planFit = {
      fit: jest.fn(async (_org: string, plan: string) => ({ plan, fits: true })),
      fitAll: jest.fn(async () => ({ starter: { plan: 'starter', fits: false }, team: { plan: 'team', fits: true } })),
    };
    const controller = new LicenseController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { isCloud: () => cloud } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      planFit as any,
    );
    return { controller, planFit };
  }
  const req = { user: { organizationId: 'org-1', sub: 'u1', role: 'MEMBER' } };

  it('returns both plans for the caller\'s workspace', async () => {
    const { controller, planFit } = make();
    await expect(controller.planFitForUser(req)).resolves.toEqual({
      plans: { starter: { plan: 'starter', fits: false }, team: { plan: 'team', fits: true } },
    });
    expect(planFit.fitAll).toHaveBeenCalledWith('org-1');
  });

  it('returns one plan on request and refuses others', async () => {
    const { controller, planFit } = make();
    await expect(controller.planFitForUser(req, 'team')).resolves.toEqual({ plans: { team: { plan: 'team', fits: true } } });
    expect(planFit.fit).toHaveBeenCalledWith('org-1', 'team');
    await expect(controller.planFitForUser(req, 'enterprise')).rejects.toThrow(BadRequestException);
  });

  it('is Cloud only and needs a workspace', async () => {
    await expect(make(false).controller.planFitForUser(req)).rejects.toThrow(NotFoundException);
    await expect(make().controller.planFitForUser({ user: {} })).rejects.toThrow(NotFoundException);
  });
});

/**
 * status, usage and instance-id have no guard: a self-hosted instance answers
 * them before anyone has signed up. Once it has a user, a visitor without a
 * dashboard token used to read the plan, features, expiry, instance id and
 * the connector, server and user counts. Now they get the empty answer Cloud
 * gives, and signed-in callers are unaffected.
 */
describe('LicenseController — anonymous reads on self-hosted', () => {
  const ACTIVE = {
    plan: 'enterprise',
    status: 'active',
    features: { sso: true, maxUsers: 50 },
    expiresAt: new Date('2027-06-30'),
    lastVerifiedAt: new Date('2026-11-25'),
    instanceId: 'inst-1234',
  };
  const USAGE = {
    plan: 'enterprise',
    connectors: { current: 12, max: null, isOver: false },
    mcpServers: { current: 4, max: null, isOver: false },
    users: { current: 9, max: 50, isOver: false },
    isOverAny: false,
  };
  const DASHBOARD = { sub: 'user-1', organizationId: 'org-1', tokenUse: 'dashboard' };

  function make(opts: { users: number; cloud?: boolean; payload?: any }) {
    const cloud = opts.cloud ?? false;
    const licenseService = {
      getCurrentLicense: jest.fn(async () => ACTIVE),
      getLatestInactiveLicense: jest.fn(async () => null),
      getPaymentFailedLicense: jest.fn(async () => null),
      getInstanceId: jest.fn(async () => 'inst-1234'),
    };
    const licenseGuard = { getUsage: jest.fn(async () => USAGE) };
    const usersService = { count: jest.fn(async () => opts.users) };
    const authService = {
      verifyToken: jest.fn(() => {
        if (opts.payload === undefined) throw new Error('Invalid or expired token');
        return opts.payload;
      }),
    };
    const controller = new LicenseController(
      licenseService as any,
      licenseGuard as any,
      authService as any,
      usersService as any,
      { isCloud: () => cloud, isSelfHosted: () => !cloud } as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, licenseService, licenseGuard, usersService };
  }

  const anonymous = { headers: {} };
  const bearer = { headers: { authorization: 'Bearer some.jwt' } };

  const EMPTY_STATUS = { plan: null, status: 'none', features: null, expiresAt: null, instanceId: null };
  const EMPTY_USAGE = {
    plan: null,
    connectors: { current: 0, max: null, isOver: false },
    mcpServers: { current: 0, max: null, isOver: false },
    users: { current: 0, max: null, isOver: false },
    isOverAny: false,
  };

  describe.each([1, 5])('once the instance has %i user(s)', (users) => {
    it('gives an anonymous visitor the empty status, like Cloud', async () => {
      const { controller, licenseService } = make({ users });
      expect(await controller.getStatus(anonymous)).toEqual(EMPTY_STATUS);
      expect(licenseService.getCurrentLicense).not.toHaveBeenCalled();
    });

    it('gives an anonymous visitor empty usage', async () => {
      const { controller, licenseGuard } = make({ users });
      expect(await controller.getUsage(anonymous)).toEqual(EMPTY_USAGE);
      expect(licenseGuard.getUsage).not.toHaveBeenCalled();
    });

    it('withholds the instance id from an anonymous visitor', async () => {
      const { controller, licenseService } = make({ users });
      expect(await controller.getInstanceId(anonymous)).toEqual({ instanceId: null });
      expect(licenseService.getInstanceId).not.toHaveBeenCalled();
    });

    it('treats an invalid or expired token as anonymous', async () => {
      const { controller } = make({ users, payload: undefined });
      expect(await controller.getStatus(bearer)).toEqual(EMPTY_STATUS);
      expect(await controller.getUsage(bearer)).toEqual(EMPTY_USAGE);
      expect(await controller.getInstanceId(bearer)).toEqual({ instanceId: null });
    });

    it('treats an MCP access token (same secret, not a dashboard token) as anonymous', async () => {
      const mcpToken = { sub: 'user-1', azp: 'dcr-client', resource: 'https://x/mcp', type: 'access' };
      const { controller } = make({ users, payload: mcpToken });
      expect(await controller.getStatus(bearer)).toEqual(EMPTY_STATUS);
      expect(await controller.getUsage(bearer)).toEqual(EMPTY_USAGE);
      expect(await controller.getInstanceId(bearer)).toEqual({ instanceId: null });
    });

    it('still answers a signed-in dashboard user in full', async () => {
      const { controller, licenseService, licenseGuard, usersService } = make({ users, payload: DASHBOARD });
      expect(await controller.getStatus(bearer)).toMatchObject({
        plan: 'enterprise',
        features: ACTIVE.features,
        instanceId: 'inst-1234',
      });
      expect(licenseService.getCurrentLicense).toHaveBeenCalledWith('org-1');
      expect(await controller.getUsage(bearer)).toEqual(USAGE);
      expect(licenseGuard.getUsage).toHaveBeenCalledWith('user-1', 'org-1');
      expect(await controller.getInstanceId(bearer)).toEqual({ instanceId: 'inst-1234' });
      // A signed-in caller never costs the user count.
      expect(usersService.count).not.toHaveBeenCalled();
    });
  });

  describe('before the first user exists (setup)', () => {
    it('keeps answering anonymously, as before', async () => {
      const { controller, licenseService, licenseGuard } = make({ users: 0 });
      expect(await controller.getStatus(anonymous)).toMatchObject({ plan: 'enterprise', instanceId: 'inst-1234' });
      expect(licenseService.getCurrentLicense).toHaveBeenCalledWith(undefined);
      expect(await controller.getUsage(anonymous)).toEqual(USAGE);
      expect(licenseGuard.getUsage).toHaveBeenCalledWith(undefined, undefined);
      expect(await controller.getInstanceId(anonymous)).toEqual({ instanceId: 'inst-1234' });
    });
  });

  describe('Cloud is unchanged', () => {
    it('answers status and usage empty without a workspace token, without counting users', async () => {
      const { controller, usersService } = make({ users: 3, cloud: true });
      expect(await controller.getStatus(anonymous)).toEqual(EMPTY_STATUS);
      expect(await controller.getUsage(anonymous)).toEqual(EMPTY_USAGE);
      expect(usersService.count).not.toHaveBeenCalled();
    });

    it('answers a workspace token in full', async () => {
      const { controller } = make({ users: 3, cloud: true, payload: DASHBOARD });
      expect(await controller.getStatus(bearer)).toMatchObject({ plan: 'enterprise' });
      expect(await controller.getUsage(bearer)).toEqual(USAGE);
    });

    it('keeps the instance id endpoint as it was', async () => {
      const { controller } = make({ users: 3, cloud: true });
      expect(await controller.getInstanceId(anonymous)).toEqual({ instanceId: 'inst-1234' });
    });
  });
});
