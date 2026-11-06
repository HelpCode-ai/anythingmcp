import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ToolRateLimitService } from './tool-rate-limit.service';

const url = process.env.TOOL_RATE_LIMIT_TEST_REDIS_URL;
(url ? describe : describe.skip)('tool rate limits — real Redis atomic admission', () => {
  let client: Redis;
  let keys: Set<string>;
  let evalSpy: jest.SpyInstance;
  const tool = { id: 'tool', name: 'sap_query' };
  let context: { userId: string; organizationId: string; authMethod: string };
  let roles: any;
  let service: ToolRateLimitService;

  beforeAll(async () => {
    client = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
  });
  beforeEach(() => {
    keys = new Set();
    const evaluate = client.eval.bind(client);
    evalSpy = jest.spyOn(client, 'eval').mockImplementation(((...args: any[]) => {
      keys.add(args[2]); keys.add(args[3]);
      return (evaluate as any)(...args);
    }) as any);
    context = { userId: 'user', organizationId: `test-983-${randomUUID()}`, authMethod: 'jwt' };
    roles = { getToolRateLimits: jest.fn().mockResolvedValue({ callsPerMinute: 5, callsPerHour: 8 }) };
    service = new ToolRateLimitService(roles, { isConfigured: true, isConnected: true, getClient: () => client } as any);
  });
  afterEach(async () => {
    evalSpy.mockRestore();
    if (keys.size > 0) await client.del(...keys);
  });
  afterAll(async () => { await client?.quit(); });

  it('admits exactly five of fifty concurrent calls across two service instances and expires both counters', async () => {
    const replica = new ToolRateLimitService(roles, { isConfigured: true, isConnected: true, getClient: () => client } as any);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? service : replica).check(tool, context)));
    expect(results.filter((result) => result === null)).toHaveLength(5);
    for (const key of keys) {
      expect(await client.get(key)).toBe('5');
      expect(await client.pttl(key)).toBeGreaterThan(0);
    }
    const [minuteKey, hourKey] = [...keys];
    expect(minuteKey.match(/\{[^}]+\}/)?.[0]).toBe(hourKey.match(/\{[^}]+\}/)?.[0]);
  });

  it('refusals consume neither window; a later minute still respects the hourly budget', async () => {
    for (let i = 0; i < 5; i++) expect(await service.check(tool, context)).toBeNull();
    expect(await service.check(tool, context)).toMatchObject({ error: expect.stringContaining('5/min') });
    const minuteKey = [...keys].find((key) => key.endsWith(':minute'))!;
    await client.del(minuteKey);
    for (let i = 0; i < 3; i++) expect(await service.check(tool, context)).toBeNull();
    expect(await service.check(tool, context)).toMatchObject({ error: expect.stringContaining('8/hour') });
    expect(await client.get(minuteKey)).toBe('3');
    const hourKey = [...keys].find((key) => key.endsWith(':hour'))!;
    expect(await client.get(hourKey)).toBe('8');
  });

  it('allows calls after real Redis expiry and returns the longest retry time', async () => {
    roles.getToolRateLimits.mockResolvedValue({ callsPerMinute: 1, callsPerHour: 1 });
    await service.check(tool, context);
    expect(await service.check(tool, context)).toMatchObject({ retryAfter: 3600 });
    for (const key of keys) await client.pexpire(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await service.check(tool, context)).toBeNull();
  });
});
