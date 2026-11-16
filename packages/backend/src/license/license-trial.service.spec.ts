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
import { LicenseService, TrialAlreadyEndedError } from './license.service';

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

function makeService(opts: { isCloud?: boolean; users?: any[]; workspace?: any } = {}) {
  const isCloud = opts.isCloud ?? true;
  const prisma = {
    license: { upsert: jest.fn(async () => ({})) },
    user: { findMany: jest.fn(async () => opts.users ?? []) },
    // The workspace as the background retry reads it: still there, no licence.
    organization: {
      findUnique: jest.fn(async () =>
        'workspace' in opts ? opts.workspace : { id: 'org-1', licenses: [] },
      ),
    },
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

  it('sends the address normalised, so a case variant is not a new address to the licence site', async () => {
    mockedAxios.post.mockResolvedValue({ data: TRIAL_RESPONSE } as any);
    const { svc } = makeService();

    await svc.requestTrialLicense(' User@Example.COM', 'User', 'org-1');

    const [, payload] = mockedAxios.post.mock.calls[0] as any[];
    expect(payload.email).toBe('user@example.com');
  });
});

describe('LicenseService — a trial answer without a key', () => {
  it('fails clearly instead of storing a licence with no key', async () => {
    // The licence API answers anonymous callers without the key (it goes by
    // email); only the service token gets it back.
    mockedAxios.post.mockResolvedValueOnce({ data: { ok: true, message: 'emailed' } });
    const { svc, prisma } = makeService();
    await expect(svc.requestTrialLicense('a@example.com', 'A', 'org-1')).rejects.toThrow(
      'Failed to start trial',
    );
    expect(prisma.license.upsert).not.toHaveBeenCalled();
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

  it('stores a trial that has already ended as expired and says so, instead of activating it', async () => {
    const ended = {
      ...TRIAL_RESPONSE,
      expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      trialDaysLeft: 0,
      alreadyExisted: true,
    };
    mockedAxios.post.mockResolvedValue({ data: ended } as any);
    const { svc, prisma, siteSettings } = makeService({ isCloud: false });

    await expect(svc.requestTrialLicense('user@example.com', 'User', 'org-1')).rejects.toBeInstanceOf(
      TrialAlreadyEndedError,
    );

    const [args] = prisma.license.upsert.mock.calls[0] as any[];
    expect(args.create.status).toBe('expired');
    expect(args.update.status).toBe('expired');
    expect(args.update.organizationId).toBe('org-1');
    // Not made the instance's licence on self-hosted.
    expect(siteSettings.set).not.toHaveBeenCalled();
  });

  it('still activates a trial that is running', async () => {
    mockedAxios.post.mockResolvedValue({ data: TRIAL_RESPONSE } as any);
    const { svc, prisma } = makeService();

    await svc.requestTrialLicense('user@example.com', 'User', 'org-1');

    const [args] = prisma.license.upsert.mock.calls[0] as any[];
    expect(args.create.status).toBe('active');
    expect(args.update.status).toBe('active');
  });
});

/**
 * 14 Nov 2026: the licence site did not answer for half a minute, a new user
 * waited 33 seconds in the Google sign-in callback for three attempts of 10
 * seconds each, and then had no trial until the hourly repair, half an hour
 * later. A sign-up now makes one attempt and leaves the rest to the background.
 */
describe('LicenseService — trial at sign-up', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Each test queues exactly the answers it needs.
    mockedAxios.post.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Let the timers due in `ms` fire and their promises settle. */
  const pass = async (ms: number) => {
    await jest.advanceTimersByTimeAsync(ms);
  };

  it('asks once while the user waits, not three times', async () => {
    mockedAxios.post.mockRejectedValue(httpError(undefined));
    const { svc } = makeService();

    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow(
      /Failed to start trial/,
    );

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
  });

  it('returns the trial when the first attempt works, and plans no retry', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: TRIAL_RESPONSE } as any);
    const { svc, prisma } = makeService();

    const result = await svc.requestTrialAtSignup('user@example.com', 'User', 'org-1');
    await pass(10 * 60_000);

    expect(result.licenseKey).toBe(TRIAL_RESPONSE.licenseKey);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('asks again in the background after 30 seconds and stores the trial it gets', async () => {
    mockedAxios.post
      .mockRejectedValueOnce(httpError(undefined))
      .mockResolvedValueOnce({ data: TRIAL_RESPONSE } as any);
    const { svc, prisma } = makeService();

    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow();
    await pass(29_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    await pass(2_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(prisma.license.upsert).toHaveBeenCalledTimes(1);
    expect((prisma.license.upsert.mock.calls[0] as any[])[0].create.organizationId).toBe('org-1');

    // Done: nothing more is asked later.
    await pass(10 * 60_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it('tries three times in the background (30 s, 2 min, 5 min) and then leaves it to the hourly repair', async () => {
    mockedAxios.post.mockRejectedValue(httpError(503));
    const { svc } = makeService();

    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow();
    await pass(31_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    await pass(121_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    await pass(301_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(4);

    await pass(60 * 60_000);
    expect(mockedAxios.post).toHaveBeenCalledTimes(4);
  });

  it('stops when the workspace got a licence another way, or was deleted', async () => {
    for (const workspace of [{ id: 'org-1', licenses: [{ id: 'lic-1' }] }, null]) {
      mockedAxios.post.mockReset();
      mockedAxios.post.mockRejectedValue(httpError(undefined));
      const { svc } = makeService({ workspace });

      await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow();
      await pass(10 * 60_000);

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps one chain of retries per workspace when sign-up is repeated', async () => {
    mockedAxios.post.mockRejectedValue(httpError(undefined));
    const { svc } = makeService();

    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow();
    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow();
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);

    await pass(31_000);
    // One background attempt, not two.
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    await svc.onModuleDestroy();
  });

  it('does not retry a trial that has already ended', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { ...TRIAL_RESPONSE, expiresAt: new Date(Date.now() - 1000).toISOString(), trialDaysLeft: 0 },
    } as any);
    const { svc } = makeService();

    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toBeInstanceOf(
      TrialAlreadyEndedError,
    );
    await pass(10 * 60_000);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('plans nothing on a self-hosted install', async () => {
    mockedAxios.post.mockRejectedValue(httpError(undefined));
    const { svc } = makeService({ isCloud: false });

    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow();
    await pass(10 * 60_000);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('drops the pending retries on shutdown', async () => {
    mockedAxios.post.mockRejectedValue(httpError(undefined));
    const { svc } = makeService();

    await expect(svc.requestTrialAtSignup('user@example.com', 'User', 'org-1')).rejects.toThrow();
    await svc.onModuleDestroy();
    await pass(10 * 60_000);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
