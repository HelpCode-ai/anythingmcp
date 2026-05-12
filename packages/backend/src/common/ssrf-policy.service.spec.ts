import { SsrfPolicyService } from './ssrf-policy.service';

type FakePrisma = {
  siteSettings: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
};

function makeService(rows: Record<string, string> = {}) {
  const prisma: FakePrisma = {
    siteSettings: {
      findUnique: jest.fn(({ where: { key } }: any) =>
        Promise.resolve(rows[key] ? { value: rows[key] } : null),
      ),
      upsert: jest.fn(({ where: { key }, update, create }: any) => {
        rows[key] = update?.value ?? create?.value;
        return Promise.resolve({ value: rows[key] });
      }),
    },
  };
  // The setDbAllowedHostsProvider side-effect in onModuleInit is harmless
  // outside Nest context — it just stores a callback.
  return new SsrfPolicyService(prisma as any);
}

describe('SsrfPolicyService', () => {
  const ORIG_ENV = process.env.SSRF_ALLOWED_HOSTS;
  beforeEach(() => {
    delete process.env.SSRF_ALLOWED_HOSTS;
  });
  afterAll(() => {
    if (ORIG_ENV === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
    else process.env.SSRF_ALLOWED_HOSTS = ORIG_ENV;
  });

  it('returns the empty list when neither env nor DB have entries', async () => {
    const svc = makeService();
    expect(await svc.getEffectiveAllowedHosts()).toEqual([]);
  });

  it('merges env-var and DB hosts, lowercased and unique', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'Env-Host,shared';
    const svc = makeService({
      ssrf_allowed_hosts: JSON.stringify(['DB-host', 'shared']),
    });
    const hosts = await svc.getEffectiveAllowedHosts();
    expect(hosts.sort()).toEqual(['db-host', 'env-host', 'shared']);
  });

  it('persists via setDbAllowedHosts and the next read reflects the change', async () => {
    const svc = makeService();
    await svc.setDbAllowedHosts(['Internal-Bridge', '*.corp.example']);
    expect(await svc.getDbAllowedHosts()).toEqual([
      'internal-bridge',
      '*.corp.example',
    ]);
  });

  it('caches the effective list for 60s and re-reads after invalidate()', async () => {
    const svc = makeService({ ssrf_allowed_hosts: JSON.stringify(['first']) });
    expect(await svc.getEffectiveAllowedHosts()).toEqual(['first']);
    // mutate DB directly, bypassing the service so the cache is stale
    (svc as any).cache.value = ['first'];
    // Without invalidate, cached value sticks
    expect(await svc.getEffectiveAllowedHosts()).toEqual(['first']);
    // After invalidate, next call hits DB again
    (svc as any).prisma.siteSettings.findUnique.mockResolvedValueOnce({
      value: JSON.stringify(['second']),
    });
    svc.invalidate();
    expect(await svc.getEffectiveAllowedHosts()).toEqual(['second']);
  });

  it('rejects host entries with unsupported characters', async () => {
    const svc = makeService();
    await expect(svc.setDbAllowedHosts(['https://oops'])).rejects.toThrow(
      /Invalid host entry/,
    );
    await expect(svc.setDbAllowedHosts(['has space'])).rejects.toThrow(
      /Invalid host entry/,
    );
  });

  it('accepts hostnames, *.suffix wildcards and bare IPs', async () => {
    const svc = makeService();
    const result = await svc.setDbAllowedHosts([
      'plain-host',
      '*.internal.example.com',
      '10.0.0.5',
      'host.with.dots',
    ]);
    expect(result).toEqual([
      'plain-host',
      '*.internal.example.com',
      '10.0.0.5',
      'host.with.dots',
    ]);
  });

  it('falls back to env-only when the DB read throws', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'env-fallback';
    const svc = makeService();
    (svc as any).prisma.siteSettings.findUnique.mockRejectedValueOnce(
      new Error('db down'),
    );
    expect(await svc.getEffectiveAllowedHosts()).toEqual(['env-fallback']);
  });
});
