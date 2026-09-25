import { LicenseService } from './license.service';

type MockLicense = {
  id: string;
  licenseKey: string;
  plan: string;
  status: string;
  features: Record<string, unknown> | null;
  expiresAt: Date | null;
  lastVerifiedAt: Date | null;
  instanceId: string | null;
  activatedAt: Date | null;
  organizationId: string | null;
  createdAt: Date;
};

function mkLicense(p: Partial<MockLicense>): MockLicense {
  return {
    id: p.id || 'id-' + Math.random().toString(36).slice(2, 8),
    licenseKey: p.licenseKey || 'AMCP-0000-0000-0000-0000',
    plan: p.plan || 'starter',
    status: p.status || 'active',
    features: p.features ?? null,
    expiresAt: p.expiresAt ?? null,
    lastVerifiedAt: p.lastVerifiedAt ?? null,
    instanceId: p.instanceId ?? 'instance-1',
    activatedAt: p.activatedAt ?? null,
    organizationId: p.organizationId ?? null,
    createdAt: p.createdAt ?? new Date(),
  };
}

function makeService({ isCloud, licenses, settings }: {
  isCloud: boolean;
  licenses: MockLicense[];
  settings?: Record<string, string>;
}) {
  const settingsStore: Record<string, string> = { ...(settings || {}) };
  const prisma = {
    license: {
      findFirst: jest.fn(async ({ where, orderBy: _orderBy }: any) => {
        const matches = licenses.filter((l) => {
          if (where?.organizationId !== undefined && l.organizationId !== where.organizationId) return false;
          if (where?.status && l.status !== where.status) return false;
          return true;
        });
        return matches[0] || null;
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        licenses.find((l) => l.licenseKey === where.licenseKey) || null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const lic = licenses.find((l) => l.id === where.id);
        if (lic) Object.assign(lic, data);
        return lic;
      }),
    },
  };
  const siteSettings = {
    get: jest.fn(async (key: string) => settingsStore[key] ?? null),
    set: jest.fn(async (key: string, value: string) => { settingsStore[key] = value; }),
  };
  const deployment = { isCloud: () => isCloud, isSelfHosted: () => !isCloud, mode: isCloud ? 'cloud' : 'self-hosted' };
  const svc = new LicenseService(prisma as any, siteSettings as any, deployment as any);
  return { svc, prisma, siteSettings, settingsStore };
}

describe('LicenseService — tenant scoping', () => {
  describe('getCurrentLicense (cloud)', () => {
    it('returns the license that belongs to the calling org', async () => {
      const orgALicense = mkLicense({ licenseKey: 'AMCP-A', organizationId: 'org-a', plan: 'starter' });
      const { svc } = makeService({
        isCloud: true,
        licenses: [orgALicense],
        settings: { license_key: 'AMCP-A' },
      });
      const result = await svc.getCurrentLicense('org-a');
      expect(result?.licenseKey).toBe('AMCP-A');
    });

    it('returns null for an org that has no license, even if the global pointer is set', async () => {
      // This is the exact scenario from the keysersoft@gmail.com bug report:
      // org B has no license of its own but site_settings.license_key still
      // points at org A's key. Pre-fix the lookup would resolve to A's key.
      const orgALicense = mkLicense({ licenseKey: 'AMCP-A', organizationId: 'org-a', plan: 'starter' });
      const { svc } = makeService({
        isCloud: true,
        licenses: [orgALicense],
        settings: { license_key: 'AMCP-A' },
      });
      const result = await svc.getCurrentLicense('org-b');
      expect(result).toBeNull();
    });

    it('does not auto-bind an unassigned license to a requesting org', async () => {
      const orphan = mkLicense({ licenseKey: 'AMCP-ORPH', organizationId: null, plan: 'enterprise' });
      const { svc, prisma } = makeService({
        isCloud: true,
        licenses: [orphan],
        settings: {},
      });
      const result = await svc.getCurrentLicense('org-x');
      expect(result).toBeNull();
      expect(prisma.license.update).not.toHaveBeenCalled();
      expect(orphan.organizationId).toBeNull();
    });
  });

  describe('getCurrentLicense (self-hosted)', () => {
    it('still falls back to the site_settings global key for single-tenant installs', async () => {
      const global = mkLicense({ licenseKey: 'AMCP-SH', organizationId: null, plan: 'business' });
      const { svc } = makeService({
        isCloud: false,
        licenses: [global],
        settings: { license_key: 'AMCP-SH' },
      });
      const result = await svc.getCurrentLicense();
      expect(result?.licenseKey).toBe('AMCP-SH');
    });

    it('auto-binds an orphan license to the calling org on first request', async () => {
      const orphan = mkLicense({ licenseKey: 'AMCP-ORPH', organizationId: null });
      const { svc, prisma } = makeService({
        isCloud: false,
        licenses: [orphan],
        settings: { license_key: 'AMCP-ORPH' },
      });
      await svc.getCurrentLicense('org-y');
      expect(prisma.license.update).toHaveBeenCalled();
      expect(orphan.organizationId).toBe('org-y');
    });
  });

  describe('verifyOnStartup', () => {
    it('is a no-op in cloud mode (per-org verification happens elsewhere)', async () => {
      const { svc, siteSettings } = makeService({ isCloud: true, licenses: [] });
      await svc.verifyOnStartup();
      expect(siteSettings.get).not.toHaveBeenCalledWith('license_key');
    });
  });
});

describe('LicenseService — a licence key stays with its workspace', () => {
  const KEY = 'AMCP-1111-2222-3333-4444';

  function withUpsert(ctx: ReturnType<typeof makeService>, licenses: MockLicense[]) {
    const upsert = jest.fn(async ({ where, update, create }: any) => {
      const lic = licenses.find((l) => l.licenseKey === where.licenseKey);
      if (lic) return Object.assign(lic, update);
      const created = mkLicense({ ...create });
      licenses.push(created);
      return created;
    });
    (ctx.prisma.license as any).upsert = upsert;
    // Remote verification answers "valid"; activation is fire-and-forget.
    jest.spyOn(ctx.svc, 'verifyLicense').mockResolvedValue({ valid: true, plan: 'team' } as any);
    jest.spyOn(ctx.svc, 'activateLicense').mockResolvedValue(true);
    jest.spyOn(ctx.svc as any, 'getInstanceId').mockResolvedValue('instance-1');
    return upsert;
  }

  it('refuses to move a paying workspace’s key into another workspace (cloud)', async () => {
    const licenses = [mkLicense({ licenseKey: KEY, plan: 'team', organizationId: 'org-paying' })];
    const ctx = makeService({ isCloud: true, licenses });
    const upsert = withUpsert(ctx, licenses);

    await expect(ctx.svc.setLicenseKey(KEY, 'org-attacker')).rejects.toThrow(/already active in another workspace/);
    expect(upsert).not.toHaveBeenCalled();
    expect(ctx.svc.verifyLicense).not.toHaveBeenCalled();
    // The paying workspace still holds its licence.
    expect(licenses[0].organizationId).toBe('org-paying');
    expect(await ctx.svc.getCurrentLicense('org-paying')).toMatchObject({ licenseKey: KEY, plan: 'team' });
    expect(await ctx.svc.getCurrentLicense('org-attacker')).toBeNull();
  });

  it('still lets the owning workspace re-enter its own key', async () => {
    const licenses = [mkLicense({ licenseKey: KEY, organizationId: 'org-paying' })];
    const ctx = makeService({ isCloud: true, licenses });
    const upsert = withUpsert(ctx, licenses);

    await expect(ctx.svc.setLicenseKey(KEY, 'org-paying')).resolves.toMatchObject({ licenseKey: KEY });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('binds a fresh key — bought on the website, never activated — to the first workspace', async () => {
    const licenses: MockLicense[] = [];
    const ctx = makeService({ isCloud: true, licenses });
    withUpsert(ctx, licenses);

    await expect(ctx.svc.setLicenseKey(KEY, 'org-new')).resolves.toMatchObject({ licenseKey: KEY });
    expect(licenses[0].organizationId).toBe('org-new');
  });

  it('does not apply to self-hosted, where one admin owns every workspace', async () => {
    const licenses = [mkLicense({ licenseKey: KEY, organizationId: 'org-a' })];
    const ctx = makeService({ isCloud: false, licenses });
    const upsert = withUpsert(ctx, licenses);

    await expect(ctx.svc.setLicenseKey(KEY, 'org-b')).resolves.toMatchObject({ licenseKey: KEY });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe('LicenseService — billing portal', () => {
  const OLD = process.env.LICENSE_SERVICE_TOKEN;
  afterEach(() => {
    process.env.LICENSE_SERVICE_TOKEN = OLD;
    jest.restoreAllMocks();
  });

  it('presents the service token, because a licence key alone no longer opens a portal', async () => {
    process.env.LICENSE_SERVICE_TOKEN = 'svc-token-0123456789abcdef';
    const licenses = [mkLicense({ licenseKey: 'AMCP-AAAA-BBBB-CCCC-DDDD', organizationId: 'org-1' })];
    const { svc } = makeService({ isCloud: true, licenses });
    const axios = require('axios');
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { url: 'https://billing.stripe.com/p/session/x' } });

    await expect(svc.createBillingPortalSession('org-1')).resolves.toEqual({ url: 'https://billing.stripe.com/p/session/x' });
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/billing\/portal$/),
      expect.objectContaining({ licenseKey: 'AMCP-AAAA-BBBB-CCCC-DDDD' }),
      expect.objectContaining({ headers: { 'x-amcp-service-token': 'svc-token-0123456789abcdef' } }),
    );
  });
});

describe('LicenseService — paid licences are re-verified', () => {
  // A paid licence used to be verified once, at activation. A subscription
  // cancelled or left unpaid on Stripe then stayed `active` in the cloud for
  // good: on 24 Sep 2026 one workspace was still calling tools two days after
  // its renewal failed.
  const axios = require('axios');
  let get: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    get = jest.spyOn(axios, 'get');
  });
  afterEach(() => {
    jest.useRealTimers();
    get.mockRestore();
  });

  function make(rows: Array<{ licenseKey: string; organizationId: string }>) {
    const updates: any[] = [];
    const prisma = {
      license: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn(async (args: any) => {
          updates.push(args);
          return {};
        }),
      },
    };
    const deployment = { isCloud: () => true };
    const svc = new LicenseService(prisma as any, {} as any, deployment as any);
    return { svc, prisma, updates };
  }

  async function run(svc: LicenseService) {
    const p = svc.reverifyPaidLicenses();
    await jest.runAllTimersAsync();
    return p;
  }

  it('asks only for active paid licences not verified in the last 20 hours', async () => {
    const { svc, prisma } = make([]);
    await run(svc);
    const where = prisma.license.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('active');
    expect(where.plan).toEqual({ not: 'trial' });
    expect(where.OR[0]).toEqual({ lastVerifiedAt: null });
  });

  it('deactivates a revoked licence and marks an expired one expired', async () => {
    const { svc, updates } = make([
      { licenseKey: 'AMCP-AAAA-0000-0000-0001', organizationId: 'o1' },
      { licenseKey: 'AMCP-BBBB-0000-0000-0002', organizationId: 'o2' },
    ]);
    get
      .mockResolvedValueOnce({ data: { valid: false, error: 'License has been revoked' } })
      .mockResolvedValueOnce({ data: { valid: false, error: 'License has expired' } });

    await expect(run(svc)).resolves.toEqual({ checked: 2, deactivated: 2, inGrace: 0, unreachable: 0 });
    expect(updates.map((u) => [u.where.licenseKey, u.data.status])).toEqual([
      ['AMCP-AAAA-0000-0000-0001', 'revoked'],
      ['AMCP-BBBB-0000-0000-0002', 'expired'],
    ]);
  });

  it('keeps a licence in its payment grace period active, until the date it was given', async () => {
    const { svc, updates } = make([{ licenseKey: 'AMCP-CCCC-0000-0000-0003', organizationId: 'o3' }]);
    get.mockResolvedValueOnce({
      data: {
        valid: true,
        plan: 'team',
        expiresAt: '2026-09-29T09:00:00.000Z',
        paymentIssue: true,
        graceUntil: '2026-09-29T09:00:00.000Z',
      },
    });

    await expect(run(svc)).resolves.toMatchObject({ checked: 1, inGrace: 1, deactivated: 0 });
    expect(updates[0].data).toMatchObject({
      status: 'active',
      plan: 'team',
      expiresAt: new Date('2026-09-29T09:00:00.000Z'),
    });
  });

  it('changes nothing when the licence server cannot be reached', async () => {
    const { svc, updates } = make([{ licenseKey: 'AMCP-DDDD-0000-0000-0004', organizationId: 'o4' }]);
    get.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));

    await expect(run(svc)).resolves.toMatchObject({ checked: 1, unreachable: 1, deactivated: 0 });
    expect(updates).toHaveLength(0);
  });

  it('presents the service token so the daily sweep is not rate limited as the public', async () => {
    process.env.LICENSE_SERVICE_TOKEN = 'test-service-token-0123456789';
    const { svc } = make([{ licenseKey: 'AMCP-EEEE-0000-0000-0005', organizationId: 'o5' }]);
    get.mockResolvedValueOnce({ data: { valid: true, plan: 'starter' } });
    await run(svc);
    expect(get.mock.calls[0][1].headers).toEqual({ 'x-amcp-service-token': 'test-service-token-0123456789' });
    delete process.env.LICENSE_SERVICE_TOKEN;
  });

  it('does nothing on a self-hosted instance', async () => {
    const prisma = { license: { findMany: jest.fn() } };
    const svc = new LicenseService(prisma as any, {} as any, { isCloud: () => false } as any);
    await expect(svc.reverifyPaidLicenses()).resolves.toEqual({
      checked: 0,
      deactivated: 0,
      inGrace: 0,
      unreachable: 0,
    });
    expect(prisma.license.findMany).not.toHaveBeenCalled();
  });
});
