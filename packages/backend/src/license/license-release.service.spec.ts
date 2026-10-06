/**
 * A deleted Cloud workspace's licence must end on the licence site too.
 *
 * Until this existed the site never heard of a deletion: trials went on
 * receiving reminder and win-back emails, and card trials went on to their
 * first charge, for workspaces that were gone.
 */
import axios from 'axios';
import { LicenseReleaseService } from './license-release.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function httpError(status?: number, error?: string) {
  return {
    response: status === undefined ? undefined : { status, data: error ? { error } : {} },
    message: `HTTP ${status}`,
  };
}

function makeService(opts: { isCloud?: boolean; orphans?: any[] } = {}) {
  const isCloud = opts.isCloud ?? true;
  const prisma = {
    license: {
      findMany: jest.fn(async () => opts.orphans ?? []),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const siteSettings = { get: jest.fn(async (k: string) => (k === 'instance_id' ? 'cloud-1' : null)) };
  const deployment = { isCloud: () => isCloud, isSelfHosted: () => !isCloud };
  const svc = new LicenseReleaseService(prisma as any, deployment as any, siteSettings as any);
  return { svc, prisma };
}

const orphan = (n: number) => ({ id: `lic-${n}`, licenseKey: `AMCP-0000-0000-0000-000${n}`, plan: 'trial' });

describe('LicenseReleaseService', () => {
  const originalToken = process.env.LICENSE_SERVICE_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LICENSE_SERVICE_TOKEN = 'service-token-for-tests-0123456789';
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.LICENSE_SERVICE_TOKEN;
    else process.env.LICENSE_SERVICE_TOKEN = originalToken;
  });

  it('looks only at licences left without a workspace that the site may still treat as live', async () => {
    const { svc, prisma } = makeService();
    await svc.releaseOrphanedLicenses();
    const where = (prisma.license.findMany.mock.calls[0] as any[])[0].where;
    expect(where.organizationId).toBeNull();
    expect(where.status).toEqual({ in: ['active', 'expired'] });
  });

  it('releases each orphan with the service token, then drops the local row', async () => {
    mockedAxios.post.mockResolvedValue({ data: { released: true, subscription: 'cancelled' } });
    const { svc, prisma } = makeService({ orphans: [orphan(1), orphan(2)] });

    const out = await svc.releaseOrphanedLicenses();

    expect(out).toEqual({ examined: 2, released: 2, refused: 0, failed: 0 });
    const [url, body, config] = mockedAxios.post.mock.calls[0] as any[];
    expect(url).toMatch(/\/api\/license\/release$/);
    expect(body).toEqual({ licenseKey: 'AMCP-0000-0000-0000-0001', instanceId: 'cloud-1' });
    expect(config.headers['x-amcp-service-token']).toBe(process.env.LICENSE_SERVICE_TOKEN);
    // Only a row that is still an orphan is removed.
    expect(prisma.license.deleteMany).toHaveBeenCalledWith({ where: { id: 'lic-1', organizationId: null } });
    expect(prisma.license.deleteMany).toHaveBeenCalledTimes(2);
  });

  it('a key the site does not know counts as released', async () => {
    mockedAxios.post.mockRejectedValue(httpError(404, 'License not found'));
    const { svc, prisma } = makeService({ orphans: [orphan(1)] });

    const out = await svc.releaseOrphanedLicenses();

    expect(out.released).toBe(1);
    expect(prisma.license.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('keeps the row for the next run when the site fails or cannot be reached', async () => {
    // A 404 without the route's answer is a site that does not have the route yet.
    for (const err of [httpError(500), httpError(429), httpError(403), httpError(404), httpError(undefined)]) {
      mockedAxios.post.mockRejectedValueOnce(err);
      const { svc, prisma } = makeService({ orphans: [orphan(1)] });

      const out = await svc.releaseOrphanedLicenses();

      expect(out.failed).toBe(1);
      expect(prisma.license.deleteMany).not.toHaveBeenCalled();
      expect(prisma.license.updateMany).not.toHaveBeenCalled();
    }
  });

  it('a refusal takes the row out of later passes without deleting it', async () => {
    mockedAxios.post.mockRejectedValue(httpError(409, 'Self-hosted licences are not released by the Cloud'));
    const { svc, prisma } = makeService({ orphans: [orphan(1)] });

    const out = await svc.releaseOrphanedLicenses();

    expect(out.refused).toBe(1);
    expect(prisma.license.deleteMany).not.toHaveBeenCalled();
    expect(prisma.license.updateMany).toHaveBeenCalledWith({
      where: { id: 'lic-1', organizationId: null },
      data: { status: 'invalid' },
    });
  });

  it('does nothing on a self-hosted install, where licences without a workspace are normal', async () => {
    const { svc, prisma } = makeService({ isCloud: false, orphans: [orphan(1)] });

    svc.releaseInBackground();
    const out = await svc.releaseOrphanedLicenses();

    expect(out.examined).toBe(0);
    expect(prisma.license.findMany).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('does nothing without the service token, which the site requires', async () => {
    delete process.env.LICENSE_SERVICE_TOKEN;
    const { svc, prisma } = makeService({ orphans: [orphan(1)] });

    const out = await svc.releaseOrphanedLicenses();

    expect(out.examined).toBe(0);
    expect(prisma.license.findMany).not.toHaveBeenCalled();
  });

  it('runs one pass at a time', async () => {
    let resolvePost: (v: any) => void = () => undefined;
    mockedAxios.post.mockReturnValue(new Promise((r) => (resolvePost = r)) as any);
    const { svc, prisma } = makeService({ orphans: [orphan(1)] });

    const a = svc.releaseOrphanedLicenses();
    const b = svc.releaseOrphanedLicenses();
    expect(a).toBe(b);
    await new Promise((r) => setImmediate(r));
    resolvePost({ data: { released: true } });
    await a;

    expect(prisma.license.findMany).toHaveBeenCalledTimes(1);
  });
});
