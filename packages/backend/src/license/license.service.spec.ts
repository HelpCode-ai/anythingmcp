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
