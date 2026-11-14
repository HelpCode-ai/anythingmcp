import axios from 'axios';
import { LicenseService } from './license.service';
import { APP_VERSION } from '../common/app-version';
import { usageReportEnabled } from './usage-report';

const KEY = 'AMCP-UUUU-0000-0000-0001';

function make(isCloud: boolean, opts: { failCount?: boolean } = {}) {
  const prisma = {
    license: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    user: {
      count: jest.fn(async () => {
        if (opts.failCount) throw new Error('db down');
        return 4;
      }),
    },
    connector: { count: jest.fn().mockResolvedValue(7) },
    mcpServerConfig: { count: jest.fn().mockResolvedValue(2) },
  };
  const svc = new LicenseService(prisma as any, {} as any, { isCloud: () => isCloud } as any);
  return { svc, prisma };
}

describe('LicenseService — what verification sends', () => {
  const OLD = process.env.LICENSE_USAGE_REPORT;
  let get: jest.SpyInstance;
  beforeEach(() => {
    delete process.env.LICENSE_USAGE_REPORT;
    get = jest.spyOn(axios, 'get').mockResolvedValue({ data: { valid: true, plan: 'community' } });
  });
  afterEach(() => {
    get.mockRestore();
    if (OLD === undefined) delete process.env.LICENSE_USAGE_REPORT;
    else process.env.LICENSE_USAGE_REPORT = OLD;
  });

  describe('usage report (self-hosted)', () => {
    it('sends active users, connectors, MCP servers and the version', async () => {
      const { svc, prisma } = make(false);
      await svc.verifyLicense(KEY);
      expect(get.mock.calls[0][1].params).toEqual({
        key: KEY,
        activeUsers: '4',
        connectors: '7',
        mcpServers: '2',
        version: APP_VERSION,
      });
      // The edition's seat count: users with an active membership.
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { memberships: { some: { deactivatedAt: null } } },
      });
    });

    it('never sends them on Cloud', async () => {
      const { svc, prisma } = make(true);
      await svc.verifyLicense(KEY);
      expect(get.mock.calls[0][1].params).toEqual({ key: KEY, billing: '1' });
      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(prisma.connector.count).not.toHaveBeenCalled();
    });

    it('sends none with LICENSE_USAGE_REPORT=false', async () => {
      process.env.LICENSE_USAGE_REPORT = 'false';
      const { svc, prisma } = make(false);
      await svc.verifyLicense(KEY);
      expect(get.mock.calls[0][1].params).toEqual({ key: KEY });
      expect(prisma.connector.count).not.toHaveBeenCalled();
    });

    it('still verifies, without the counts, when counting fails', async () => {
      const { svc } = make(false, { failCount: true });
      await expect(svc.verifyLicense(KEY)).resolves.toMatchObject({ valid: true, plan: 'community' });
      expect(get.mock.calls[0][1].params).toEqual({ key: KEY });
    });

    it('reads the opt-out from the environment', () => {
      expect(usageReportEnabled({})).toBe(true);
      expect(usageReportEnabled({ LICENSE_USAGE_REPORT: 'true' })).toBe(true);
      expect(usageReportEnabled({ LICENSE_USAGE_REPORT: 'false' })).toBe(false);
      expect(usageReportEnabled({ LICENSE_USAGE_REPORT: ' FALSE ' })).toBe(false);
      expect(usageReportEnabled({ LICENSE_USAGE_REPORT: '0' })).toBe(false);
    });
  });

  describe('workspace on Cloud', () => {
    const SELF_HOSTED_ERROR =
      'This licence is for a self-hosted AnythingMCP instance. On AnythingMCP Cloud, choose a Cloud plan on the License page.';

    it('setLicenseKey sends organizationId and surfaces the site error', async () => {
      const { svc, prisma } = make(true);
      get.mockResolvedValueOnce({ data: { valid: false, error: SELF_HOSTED_ERROR } });
      await expect(svc.setLicenseKey(KEY, 'org-1')).rejects.toThrow(SELF_HOSTED_ERROR);
      expect(get.mock.calls[0][1].params).toEqual({ key: KEY, billing: '1', organizationId: 'org-1' });
      expect(prisma.license.upsert).not.toHaveBeenCalled();
    });

    it('verifyLicense for a workspace sends its organizationId', async () => {
      const { svc } = make(true);
      await svc.verifyLicense(KEY, 'org-2');
      expect(get.mock.calls[0][1].params).toEqual({ key: KEY, billing: '1', organizationId: 'org-2' });
    });

    it('self-hosted never sends organizationId', async () => {
      process.env.LICENSE_USAGE_REPORT = 'false';
      const { svc } = make(false);
      await svc.verifyLicense(KEY, 'org-1');
      expect(get.mock.calls[0][1].params).toEqual({ key: KEY });
    });
  });
});
