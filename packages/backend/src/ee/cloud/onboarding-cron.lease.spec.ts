import { OnboardingCronService } from './onboarding-cron.service';

/**
 * The single-flight lease around run(): a timer on the Cloud host and the
 * GitHub workflow both call the cron, so two calls at once must not both run.
 * The lease is a site_settings row; this fake keeps it in memory with the same
 * semantics as the Prisma calls the service makes.
 */
function fakeSiteSettings() {
  const rows = new Map<string, { id: string; key: string; value: string; updatedAt: Date }>();
  return {
    rows,
    updateMany: jest.fn(async ({ where, data }: any) => {
      const row = rows.get(where.key);
      if (!row) return { count: 0 };
      const free =
        where.value !== undefined
          ? row.value === where.value
          : where.OR.some((c: any) =>
              c.value !== undefined ? row.value === c.value : row.updatedAt < c.updatedAt.lt,
            );
      if (!free) return { count: 0 };
      row.value = data.value;
      row.updatedAt = new Date();
      return { count: 1 };
    }),
    findUnique: jest.fn(async ({ where }: any) => (rows.has(where.key) ? { id: rows.get(where.key)!.id } : null)),
    create: jest.fn(async ({ data }: any) => {
      if (rows.has(data.key)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      rows.set(data.key, { id: 'r1', key: data.key, value: data.value, updatedAt: new Date() });
      return rows.get(data.key);
    }),
  };
}

function makeService(siteSettings: ReturnType<typeof fakeSiteSettings>) {
  const service = new OnboardingCronService({ siteSettings } as any, {} as any, {} as any, {} as any);
  return service;
}

describe('OnboardingCronService.runExclusive', () => {
  it('runs once when two calls arrive together, and frees the lease afterwards', async () => {
    const ss = fakeSiteSettings();
    const service = makeService(ss);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = jest.spyOn(service, 'run').mockImplementation(async () => {
      await gate;
      return { examined: 1 } as any;
    });

    const first = service.runExclusive();
    await new Promise((r) => setImmediate(r));
    const second = await service.runExclusive();
    release();

    expect(second).toBeNull();
    expect(await first).toEqual({ examined: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(ss.rows.get('onboarding_cron_lease')!.value).toBe('');

    // Free again: the next call runs.
    expect(await service.runExclusive()).toEqual({ examined: 1 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('takes over a lease left by a run that died more than 30 minutes ago', async () => {
    const ss = fakeSiteSettings();
    ss.rows.set('onboarding_cron_lease', {
      id: 'r1',
      key: 'onboarding_cron_lease',
      value: 'crashed-holder',
      updatedAt: new Date(Date.now() - 31 * 60 * 1000),
    });
    const service = makeService(ss);
    jest.spyOn(service, 'run').mockResolvedValue({ examined: 2 } as any);

    expect(await service.runExclusive()).toEqual({ examined: 2 });
  });

  it('skips while a recent lease is held, and releases its own lease even when run() throws', async () => {
    const ss = fakeSiteSettings();
    ss.rows.set('onboarding_cron_lease', {
      id: 'r1',
      key: 'onboarding_cron_lease',
      value: 'other-holder',
      updatedAt: new Date(),
    });
    const service = makeService(ss);
    const run = jest.spyOn(service, 'run').mockRejectedValue(new Error('boom'));

    expect(await service.runExclusive()).toBeNull();
    expect(run).not.toHaveBeenCalled();

    ss.rows.get('onboarding_cron_lease')!.value = '';
    await expect(service.runExclusive()).rejects.toThrow('boom');
    expect(ss.rows.get('onboarding_cron_lease')!.value).toBe('');
  });

  it('treats losing the race to create the lease row as "already running"', async () => {
    const ss = fakeSiteSettings();
    ss.findUnique.mockResolvedValueOnce(null);
    ss.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    const service = makeService(ss);
    const run = jest.spyOn(service, 'run');

    expect(await service.runExclusive()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
