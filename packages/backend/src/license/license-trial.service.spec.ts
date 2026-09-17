/**
 * The trial path, which had been losing customers.
 *
 * Trial activation is best-effort by design: email verification must succeed
 * even when the licence API does not answer. That made every transient failure
 * invisible, and on 2026-09-16 the cloud had 131 verified users with no licence
 * at all — the licence API rate-limits per IP and every cloud trial request
 * leaves from the same droplet, so the whole tenancy shared three trials an
 * hour. These tests pin the three things that now stop that from happening:
 * the service token, the retry, and the repair pass.
 */
import axios from 'axios';
import { LicenseService } from './license.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const TRIAL_RESPONSE = {
  licenseKey: 'AMCP-TRIA-L000-0000-0001',
  plan: 'trial',
  features: { maxUsers: 3 },
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  trialDaysLeft: 7,
};

function httpError(status?: number) {
  return { response: status === undefined ? undefined : { status }, message: `HTTP ${status}` };
}

function makeService(opts: { isCloud?: boolean; users?: any[] } = {}) {
  const isCloud = opts.isCloud ?? true;
  const prisma = {
    license: { upsert: jest.fn(async () => ({})) },
    user: { findMany: jest.fn(async () => opts.users ?? []) },
  };
  const siteSettings = {
    get: jest.fn(async (k: string) => (k === 'instance_id' ? 'instance-1' : null)),
    set: jest.fn(async () => undefined),
  };
  const deployment = { isCloud: () => isCloud, isSelfHosted: () => !isCloud };
  const svc = new LicenseService(prisma as any, siteSettings as any, deployment as any);
  return { svc, prisma, siteSettings };
}

describe('LicenseService — trial acquisition', () => {
  const originalToken = process.env.LICENSE_SERVICE_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRIAL_RETRY_BASE_MS = '1';
    delete process.env.LICENSE_SERVICE_TOKEN;
  });

  afterAll(() => {
    delete process.env.TRIAL_RETRY_BASE_MS;
    if (originalToken === undefined) delete process.env.LICENSE_SERVICE_TOKEN;
    else process.env.LICENSE_SERVICE_TOKEN = originalToken;
  });

  it('retries a 429 instead of dropping the trial, and stores the licence it finally gets', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ data: TRIAL_RESPONSE } as any);
    const { svc, prisma } = makeService();

    const result = await svc.requestTrialLicense('user@example.com', 'User', 'org-1');

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(result.licenseKey).toBe(TRIAL_RESPONSE.licenseKey);
    expect(prisma.license.upsert).toHaveBeenCalledTimes(1);
  });

  it('retries when the licence API does not answer at all', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(httpError(undefined))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ data: TRIAL_RESPONSE } as any);
    const { svc } = makeService();

    await expect(svc.requestTrialLicense('user@example.com', 'User')).resolves.toMatchObject({
      plan: 'trial',
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });

  it('gives up after the third attempt rather than hammering', async () => {
    mockedAxios.post.mockRejectedValue(httpError(429));
    const { svc } = makeService();

    await expect(svc.requestTrialLicense('user@example.com', 'User')).rejects.toThrow(
      /Too many requests/,
    );
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request the licence API rejected on its merits', async () => {
    mockedAxios.post.mockRejectedValue(httpError(400));
    const { svc } = makeService();

    await expect(svc.requestTrialLicense('nope', 'User')).rejects.toThrow();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('presents the service token so the cloud is not throttled as one anonymous visitor', async () => {
    process.env.LICENSE_SERVICE_TOKEN = 'a-token-long-enough-to-count';
    mockedAxios.post.mockResolvedValue({ data: TRIAL_RESPONSE } as any);
    const { svc } = makeService();

    await svc.requestTrialLicense('user@example.com', 'User');

    const [, , config] = mockedAxios.post.mock.calls[0] as any[];
    expect(config.headers['x-amcp-service-token']).toBe('a-token-long-enough-to-count');
  });

  it('sends no token header when none is configured, so self-hosted keeps the public limit', async () => {
    mockedAxios.post.mockResolvedValue({ data: TRIAL_RESPONSE } as any);
    const { svc } = makeService();

    await svc.requestTrialLicense('user@example.com', 'User');

    const [, , config] = mockedAxios.post.mock.calls[0] as any[];
    expect(config.headers).toEqual({});
  });

  it('never sends the organization id, so one email cannot farm a trial per workspace', async () => {
    mockedAxios.post.mockResolvedValue({ data: TRIAL_RESPONSE } as any);
    const { svc } = makeService();

    await svc.requestTrialLicense('user@example.com', 'User', 'org-1');

    const [, payload] = mockedAxios.post.mock.calls[0] as any[];
    expect(payload).toEqual({ email: 'user@example.com', name: 'User', instanceId: 'instance-1' });
  });
});

describe('LicenseService — repairMissingTrials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRIAL_RETRY_BASE_MS = '1';
  });

  it('gives a trial to every verified user whose workspace has none', async () => {
    mockedAxios.post.mockResolvedValue({ data: TRIAL_RESPONSE } as any);
    const { svc, prisma } = makeService({
      users: [
        { id: 'u1', email: 'a@example.com', name: 'A', organizationId: 'org-a' },
        { id: 'u2', email: 'b@example.com', name: null, organizationId: 'org-b' },
      ],
    });

    const out = await svc.repairMissingTrials();

    expect(out).toEqual({ examined: 2, repaired: 2, failed: 0 });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailVerified: true,
          organization: { licenses: { none: {} } },
        }),
      }),
    );
  });

  it('keeps going when one user cannot be repaired', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(httpError(400))
      .mockResolvedValueOnce({ data: TRIAL_RESPONSE } as any);
    const { svc } = makeService({
      users: [
        { id: 'u1', email: 'bad', name: 'A', organizationId: 'org-a' },
        { id: 'u2', email: 'b@example.com', name: 'B', organizationId: 'org-b' },
      ],
    });

    await expect(svc.repairMissingTrials()).resolves.toEqual({
      examined: 2,
      repaired: 1,
      failed: 1,
    });
  });

  it('does nothing on a self-hosted install, which has no trials to repair', async () => {
    const { svc, prisma } = makeService({ isCloud: false });

    await expect(svc.repairMissingTrials()).resolves.toEqual({
      examined: 0,
      repaired: 0,
      failed: 0,
    });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
