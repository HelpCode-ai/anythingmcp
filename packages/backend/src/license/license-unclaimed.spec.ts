import { LicenseService } from './license.service';
import {
  formatSkipReasons,
  isSettled,
  parseUnclaimedLicences,
  UNCLAIMED_SETTLE_MS,
  UNCLAIMED_SWEEP_MS,
} from './license-unclaimed';

const KEY_A = 'AMCP-AAAA-BBBB-CCCC-0001';
const KEY_B = 'AMCP-AAAA-BBBB-CCCC-0002';

describe('formatSkipReasons', () => {
  it('lists the reasons in a fixed order and is empty without skips', () => {
    expect(formatSkipReasons(new Map())).toBe('');
    expect(
      formatSkipReasons(
        new Map([
          ['already_paid', 1],
          ['no_account', 3],
        ]),
      ),
    ).toBe(' (no_account=3, already_paid=1)');
  });
});

describe('isSettled', () => {
  const NOW = new Date('2026-11-05T18:31:00Z');
  it('waits UNCLAIMED_SETTLE_MS after the sale, so the buyer\'s browser binds first', () => {
    const at = (ms: number) => ({ key: KEY_A, email: 'a@example.com', plan: 'starter', createdAt: new Date(NOW.getTime() - ms) });
    expect(isSettled(at(UNCLAIMED_SETTLE_MS - 1000), NOW)).toBe(false);
    expect(isSettled(at(UNCLAIMED_SETTLE_MS), NOW)).toBe(true);
    expect(isSettled({ key: KEY_A, email: 'a@example.com', plan: 'starter' }, NOW)).toBe(true);
  });

  it('binds within a few minutes of the payment, not at the next hourly cron', () => {
    expect(UNCLAIMED_SETTLE_MS + UNCLAIMED_SWEEP_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe('parseUnclaimedLicences', () => {
  it('keeps well-formed entries, normalises the address and drops duplicates', () => {
    expect(
      parseUnclaimedLicences({
        licences: [
          { key: KEY_A, email: ' Ann@Example.com ', plan: 'starter', createdAt: '2026-10-28T14:54:45Z' },
          { key: KEY_A, email: 'ann@example.com', plan: 'starter' },
          { key: KEY_B, email: 'bob@example.org', plan: 'team', organizationId: 'org-b' },
          { key: 'not-a-key', email: 'x@example.com', plan: 'starter' },
          { key: 'AMCP-AAAA-BBBB-CCCC-0003', email: 'no-at-sign', plan: 'starter' },
          null,
        ],
      }),
    ).toEqual([
      { key: KEY_A, email: 'ann@example.com', plan: 'starter', createdAt: new Date('2026-10-28T14:54:45Z') },
      { key: KEY_B, email: 'bob@example.org', plan: 'team', organizationId: 'org-b' },
    ]);
  });

  it('drops a sale date it cannot read', () => {
    expect(
      parseUnclaimedLicences({ licences: [{ key: KEY_A, email: 'a@example.com', plan: 'starter', createdAt: 'soon' }] }),
    ).toEqual([{ key: KEY_A, email: 'a@example.com', plan: 'starter' }]);
  });

  it('returns null when the answer has no list', () => {
    expect(parseUnclaimedLicences({})).toBeNull();
    expect(parseUnclaimedLicences(null)).toBeNull();
    expect(parseUnclaimedLicences({ licences: 'x' })).toBeNull();
  });
});

describe('LicenseService — paid licences that never reached their workspace', () => {
  const OLD = process.env.LICENSE_SERVICE_TOKEN;
  const axios = require('axios');
  const NOW = new Date('2026-11-02T14:00:00Z');

  type User = { email: string; role: string; organizationId: string | null; emailVerified: boolean };
  type Local = { licenseKey: string; organizationId: string | null; plan: string; status: string; expiresAt: Date | null; billing?: unknown };

  function make({
    users = [],
    orgs = [],
    locals = [],
    isCloud = true,
  }: { users?: User[]; orgs?: string[]; locals?: Local[]; isCloud?: boolean } = {}) {
    const prisma = {
      user: {
        findFirst: jest.fn(async ({ where }: any) => {
          const wanted = String(where.email.equals).toLowerCase();
          return (
            users.find((u) => u.email.toLowerCase() === wanted && u.emailVerified && u.organizationId) ?? null
          );
        }),
      },
      organization: {
        findUnique: jest.fn(async ({ where }: any) => (orgs.includes(where.id) ? { id: where.id } : null)),
      },
      license: {
        findUnique: jest.fn(async ({ where }: any) => locals.find((l) => l.licenseKey === where.licenseKey) ?? null),
        findMany: jest.fn(async ({ where }: any) =>
          locals.filter((l) => l.organizationId === where.organizationId && l.plan !== 'trial'),
        ),
      },
    };
    const svc = new LicenseService(prisma as any, {} as any, { isCloud: () => isCloud } as any);
    const setKey = jest.spyOn(svc, 'setLicenseKey').mockResolvedValue({} as any);
    const activate = jest.spyOn(svc, 'activateLicense').mockResolvedValue(true);
    return { svc, prisma, setKey, activate };
  }

  function siteLists(licences: unknown[]) {
    return jest.spyOn(axios, 'post').mockResolvedValue({ data: { licences } });
  }

  beforeEach(() => {
    process.env.LICENSE_SERVICE_TOKEN = 'svc-token-0123456789abcdef';
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as any;
    }) as any);
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.LICENSE_SERVICE_TOKEN;
    else process.env.LICENSE_SERVICE_TOKEN = OLD;
    jest.restoreAllMocks();
  });

  it('binds a licence to the workspace its buyer administers, found by address', async () => {
    const { svc, setKey } = make({
      users: [{ email: 'ann@example.com', role: 'ADMIN', organizationId: 'org-a', emailVerified: true }],
      locals: [{ licenseKey: 'AMCP-TRIA-L000-0000-0000', organizationId: 'org-a', plan: 'trial', status: 'expired', expiresAt: null }],
    });
    const post = siteLists([{ key: KEY_A, email: 'Ann@Example.com', plan: 'starter' }]);

    const out = await svc.bindUnclaimedPaidLicences(NOW);

    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/license\/unclaimed$/),
      {},
      expect.objectContaining({ headers: { 'x-amcp-service-token': 'svc-token-0123456789abcdef' } }),
    );
    expect(setKey).toHaveBeenCalledWith(KEY_A, 'org-a');
    expect(out).toEqual({ listed: 1, bound: 1, skipped: 0, failed: 0 });
  });

  it('uses the workspace the checkout named, when it still exists', async () => {
    const { svc, setKey } = make({ orgs: ['org-b'] });
    siteLists([{ key: KEY_B, email: 'bob@example.org', plan: 'team', organizationId: 'org-b' }]);

    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ bound: 1 });
    expect(setKey).toHaveBeenCalledWith(KEY_B, 'org-b');
  });

  it('leaves a licence alone without a verified admin account or workspace', async () => {
    const { svc, setKey } = make({
      users: [
        { email: 'member@example.com', role: 'EDITOR', organizationId: 'org-m', emailVerified: true },
        { email: 'unverified@example.com', role: 'ADMIN', organizationId: 'org-u', emailVerified: false },
      ],
    });
    siteLists([
      { key: KEY_A, email: 'member@example.com', plan: 'starter' },
      { key: KEY_B, email: 'unverified@example.com', plan: 'starter' },
      { key: 'AMCP-AAAA-BBBB-CCCC-0003', email: 'gone@example.com', plan: 'starter', organizationId: 'org-gone' },
    ]);

    const log = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toEqual({ listed: 3, bound: 0, skipped: 3, failed: 0 });
    expect(setKey).not.toHaveBeenCalled();
    // The per-licence lines for these reasons are debug: the summary says why.
    expect(log).toHaveBeenCalledWith(
      'Unclaimed licences: listed=3 bound=0 skipped=3 (no_account=1, not_admin=1, no_workspace=1) failed=0',
    );
  });

  it('does not bind a second subscription to a workspace that already pays', async () => {
    const { svc, setKey } = make({
      users: [{ email: 'tom@example.com', role: 'ADMIN', organizationId: 'org-t', emailVerified: true }],
      locals: [{ licenseKey: 'AMCP-PAID-0000-0000-0000', organizationId: 'org-t', plan: 'starter', status: 'active', expiresAt: null }],
    });
    siteLists([{ key: KEY_A, email: 'tom@example.com', plan: 'starter' }]);

    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ bound: 0, skipped: 1 });
    expect(setKey).not.toHaveBeenCalled();
  });

  it('never moves a key bound here to another workspace', async () => {
    const { svc, setKey, activate } = make({
      users: [{ email: 'ann@example.com', role: 'ADMIN', organizationId: 'org-a', emailVerified: true }],
      locals: [{ licenseKey: KEY_A, organizationId: 'org-other', plan: 'starter', status: 'active', expiresAt: null }],
    });
    siteLists([{ key: KEY_A, email: 'ann@example.com', plan: 'starter' }]);

    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ bound: 0, skipped: 1 });
    expect(setKey).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it('activates again a key bound here whose activation never reached the site', async () => {
    const { svc, setKey, activate } = make({
      users: [{ email: 'ann@example.com', role: 'ADMIN', organizationId: 'org-a', emailVerified: true }],
      locals: [{ licenseKey: KEY_A, organizationId: 'org-a', plan: 'starter', status: 'active', expiresAt: null }],
    });
    siteLists([{ key: KEY_A, email: 'ann@example.com', plan: 'starter' }]);

    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ bound: 1 });
    expect(activate).toHaveBeenCalledWith(KEY_A, 'org-a');
    expect(setKey).not.toHaveBeenCalled();
  });

  it('counts a refused binding as failed and carries on', async () => {
    const { svc, setKey } = make({
      users: [
        { email: 'ann@example.com', role: 'ADMIN', organizationId: 'org-a', emailVerified: true },
        { email: 'bob@example.org', role: 'ADMIN', organizationId: 'org-b', emailVerified: true },
      ],
    });
    setKey.mockRejectedValueOnce(new Error('License is revoked'));
    siteLists([
      { key: KEY_A, email: 'ann@example.com', plan: 'starter' },
      { key: KEY_B, email: 'bob@example.org', plan: 'starter' },
    ]);

    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toEqual({ listed: 2, bound: 1, skipped: 0, failed: 1 });
  });

  it('leaves a licence sold in the last two minutes for the buyer\'s browser', async () => {
    const { svc, setKey } = make({
      users: [{ email: 'ann@example.com', role: 'ADMIN', organizationId: 'org-a', emailVerified: true }],
    });
    siteLists([
      { key: KEY_A, email: 'ann@example.com', plan: 'starter', createdAt: new Date(NOW.getTime() - 60 * 1000).toISOString() },
    ]);

    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toEqual({ listed: 0, bound: 0, skipped: 0, failed: 0 });
    expect(setKey).not.toHaveBeenCalled();

    siteLists([
      { key: KEY_A, email: 'ann@example.com', plan: 'starter', createdAt: new Date(NOW.getTime() - 3 * 60 * 1000).toISOString() },
    ]);
    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ bound: 1 });
    expect(setKey).toHaveBeenCalledWith(KEY_A, 'org-a');
  });

  it('a quiet run logs only when it binds or fails, and keeps its warnings at debug', async () => {
    const { svc, setKey } = make({
      users: [{ email: 'tom@example.com', role: 'ADMIN', organizationId: 'org-t', emailVerified: true }],
      locals: [{ licenseKey: 'AMCP-PAID-0000-0000-0000', organizationId: 'org-t', plan: 'starter', status: 'active', expiresAt: null }],
    });
    const log = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((svc as any).logger, 'debug').mockImplementation(() => undefined);

    siteLists([
      { key: KEY_A, email: 'tom@example.com', plan: 'starter' },
      { key: KEY_B, email: 'nobody@example.com', plan: 'starter' },
    ]);
    await expect(svc.bindUnclaimedPaidLicences(NOW, { quiet: true })).resolves.toMatchObject({ skipped: 2 });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    jest.spyOn(axios, 'post').mockRejectedValueOnce(new Error('down'));
    await svc.bindUnclaimedPaidLicences(NOW, { quiet: true });
    expect(warn).not.toHaveBeenCalled();

    // The hourly run still says it all.
    siteLists([{ key: KEY_A, email: 'tom@example.com', plan: 'starter' }]);
    await svc.bindUnclaimedPaidLicences(NOW);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left unbound: already_paid'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Unclaimed licences: listed=1 bound=0 skipped=1'));

    // A quiet run that binds is logged.
    log.mockClear();
    siteLists([{ key: KEY_B, email: 'tom2@example.com', plan: 'starter', organizationId: 'org-b' }]);
    (svc as any).prisma.organization.findUnique.mockResolvedValueOnce({ id: 'org-b' });
    await expect(svc.bindUnclaimedPaidLicences(NOW, { quiet: true })).resolves.toMatchObject({ bound: 1 });
    expect(setKey).toHaveBeenCalledWith(KEY_B, 'org-b');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Unclaimed licences: listed=1 bound=1'));
  });

  it('runs one binding at a time: the minute sweep and the hourly cron never overlap', async () => {
    const { svc, setKey } = make({
      users: [{ email: 'ann@example.com', role: 'ADMIN', organizationId: 'org-a', emailVerified: true }],
    });
    let release!: (v: unknown) => void;
    jest.spyOn(axios, 'post').mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ data: { licences: [{ key: KEY_A, email: 'ann@example.com', plan: 'starter' }] } }))),
    );

    const first = svc.bindUnclaimedPaidLicences(NOW, { quiet: true });
    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toEqual({ listed: 0, bound: 0, skipped: 0, failed: 0 });
    release(undefined);
    await expect(first).resolves.toMatchObject({ bound: 1 });
    expect(setKey).toHaveBeenCalledTimes(1);

    // Free again once the run is over.
    siteLists([]);
    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ listed: 0 });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('starts the minute sweep on the Cloud only, and stops it on shutdown', async () => {
    const cloud = make();
    const selfHosted = make({ isCloud: false });
    for (const { svc } of [cloud, selfHosted]) {
      jest.spyOn(svc, 'ensureInstanceId').mockResolvedValue('inst');
      jest.spyOn(svc as any, 'verifyOnStartup').mockResolvedValue(undefined);
    }
    const every = jest.spyOn(global, 'setInterval');
    const stop = jest.spyOn(global, 'clearInterval');

    await cloud.svc.onModuleInit();
    expect(every).toHaveBeenCalledWith(expect.any(Function), UNCLAIMED_SWEEP_MS);
    const bind = jest.spyOn(cloud.svc, 'bindUnclaimedPaidLicences').mockResolvedValue({} as any);
    (every.mock.calls.find((c) => c[1] === UNCLAIMED_SWEEP_MS)![0] as () => void)();
    expect(bind).toHaveBeenCalledWith(expect.any(Date), { quiet: true });
    cloud.svc.onModuleDestroy();
    expect(stop).toHaveBeenCalled();

    every.mockClear();
    await selfHosted.svc.onModuleInit();
    expect(every.mock.calls.some((c) => c[1] === UNCLAIMED_SWEEP_MS)).toBe(false);
    selfHosted.svc.onModuleDestroy();
  });

  it('does nothing when the site fails, without a service token, or off the Cloud', async () => {
    const { svc, setKey } = make();
    jest.spyOn(axios, 'post').mockRejectedValueOnce(new Error('down'));
    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toEqual({ listed: 0, bound: 0, skipped: 0, failed: 0 });

    delete process.env.LICENSE_SERVICE_TOKEN;
    const post = jest.spyOn(axios, 'post');
    post.mockClear();
    await expect(svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ listed: 0 });

    process.env.LICENSE_SERVICE_TOKEN = 'svc-token-0123456789abcdef';
    const selfHosted = make({ isCloud: false });
    await expect(selfHosted.svc.bindUnclaimedPaidLicences(NOW)).resolves.toMatchObject({ listed: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(setKey).not.toHaveBeenCalled();
  });
});
