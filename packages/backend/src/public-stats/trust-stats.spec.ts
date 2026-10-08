import axios from 'axios';
import {
  formatDownloads,
  formatStars,
  formatToolCalls,
  formatTrustStats,
  formatWorkspaces,
} from './trust-stats.format';
import { TRUST_STATS_TTL_MS, TrustStatsService } from './trust-stats.service';
import { PublicStatsController } from './public-stats.controller';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

describe('trust number formatting (always rounded down)', () => {
  it.each([
    [984, '984'],
    [999, '999'],
    [1000, '1,000+'],
    [1099, '1,000+'],
    [1100, '1,100+'],
    [12_345, '12,300+'],
    [0, null],
    [null, null],
    [Number.NaN, null],
  ])('stars %p -> %p', (n, out) => expect(formatStars(n as any)).toBe(out));

  it.each([
    [32_456, '32,000+'],
    [999, null],
    [1000, '1,000+'],
  ])('downloads %p -> %p', (n, out) => expect(formatDownloads(n)).toBe(out));

  it.each([
    [3_871, '3,800+'],
    [99, null],
    [100, '100+'],
  ])('workspaces %p -> %p', (n, out) => expect(formatWorkspaces(n)).toBe(out));

  it.each([
    [654_321, '650,000+'],
    [9_999, null],
    [10_000, '10,000+'],
    [1_000_000, '1M+'],
    [2_345_678, '2M+'],
  ])('tool calls %p -> %p', (n, out) => expect(formatToolCalls(n)).toBe(out));

  it('formats a whole set, never below the floors', () => {
    expect(
      formatTrustStats({ githubStars: 984, dockerPulls: 32_456, workspaces: 3_871, toolCalls30d: 654_321, updatedAt: null }),
    ).toEqual({ stars: '1,000+', downloads: '200,000+', workspaces: '3,800+', toolCalls: '1M+' });
    expect(
      formatTrustStats({ githubStars: 1_234, dockerPulls: 250_400, workspaces: null, toolCalls30d: 2_100_000, updatedAt: null }),
    ).toEqual({ stars: '1,200+', downloads: '250,000+', workspaces: null, toolCalls: '2M+' });
    expect(formatTrustStats(null)).toEqual({ stars: '1,000+', downloads: '200,000+', workspaces: null, toolCalls: '1M+' });
  });
});

describe('TrustStatsService', () => {
  let prisma: { organization: { count: jest.Mock }; toolInvocation: { count: jest.Mock } };

  beforeEach(() => {
    jest.useRealTimers();
    mockedGet.mockReset();
    mockedGet.mockImplementation(async (url: string) =>
      url.includes('github')
        ? { data: { stargazers_count: 984 } }
        : { data: { pull_count: 32_456 } },
    );
    prisma = {
      organization: { count: jest.fn().mockResolvedValue(3_871) },
      toolInvocation: { count: jest.fn().mockResolvedValue(654_321) },
    };
  });

  it('loads GitHub, Docker Hub and the two database counts', async () => {
    const service = new TrustStatsService(prisma as any);
    const stats = await service.get();
    expect(stats).toMatchObject({ githubStars: 984, dockerPulls: 32_456, workspaces: 3_871, toolCalls30d: 654_321 });
    expect(stats.updatedAt).toEqual(expect.any(String));
    // Tool calls of the last 30 days only.
    const since: Date = prisma.toolInvocation.count.mock.calls[0][0].where.createdAt.gte;
    expect(Date.now() - since.getTime()).toBeGreaterThan(29.9 * 86_400_000);
    expect(Date.now() - since.getTime()).toBeLessThan(30.1 * 86_400_000);
    // Both external calls have a timeout.
    for (const call of mockedGet.mock.calls) expect(call[1].timeout).toBeGreaterThan(0);
  });

  it('serves the cache for an hour, then refreshes in the background', async () => {
    const service = new TrustStatsService(prisma as any);
    await service.get();
    await service.get();
    expect(prisma.organization.count).toHaveBeenCalledTimes(1);

    const realNow = Date.now;
    Date.now = () => realNow() + TRUST_STATS_TTL_MS + 1000;
    try {
      prisma.organization.count.mockResolvedValue(3_999);
      const stale = await service.get();
      expect(stale.workspaces).toBe(3_871); // served at once
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect((await service.get()).workspaces).toBe(3_999);
    } finally {
      Date.now = realNow;
    }
  });

  it('keeps the last known value when a source fails', async () => {
    const service = new TrustStatsService(prisma as any);
    await service.get();
    mockedGet.mockRejectedValue(new Error('timeout'));
    prisma.toolInvocation.count.mockRejectedValue(new Error('db down'));
    const realNow = Date.now;
    Date.now = () => realNow() + TRUST_STATS_TTL_MS + 1000;
    try {
      await service.get();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(await service.get()).toMatchObject({ githubStars: 984, dockerPulls: 32_456, toolCalls30d: 654_321 });
    } finally {
      Date.now = realNow;
    }
  });

  it('returns nulls, not an error, when nothing has ever loaded', async () => {
    mockedGet.mockRejectedValue(new Error('offline'));
    prisma.organization.count.mockRejectedValue(new Error('db down'));
    prisma.toolInvocation.count.mockRejectedValue(new Error('db down'));
    const service = new TrustStatsService(prisma as any);
    expect(await service.get()).toEqual({
      githubStars: null,
      dockerPulls: null,
      workspaces: null,
      toolCalls30d: null,
      updatedAt: null,
    });
  });

  it('ignores a malformed answer', async () => {
    mockedGet.mockResolvedValue({ data: { stargazers_count: 'lots', pull_count: -1 } });
    const service = new TrustStatsService(prisma as any);
    const stats = await service.get();
    expect(stats.githubStars).toBeNull();
    expect(stats.dockerPulls).toBeNull();
  });

  it('runs one refresh at a time', async () => {
    const service = new TrustStatsService(prisma as any);
    await Promise.all([service.get(), service.get(), service.get()]);
    expect(prisma.organization.count).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/public/stats', () => {
  it('returns the aggregates only, cacheable and readable cross-origin', async () => {
    const stats = {
      get: jest.fn().mockResolvedValue({
        githubStars: 984,
        dockerPulls: 32_456,
        workspaces: 3_871,
        toolCalls30d: 654_321,
        updatedAt: '2026-10-07T10:00:00.000Z',
      }),
    };
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => (headers[k] = v),
      removeHeader: (k: string) => delete headers[k],
    };
    const body = await new PublicStatsController(stats as any).getStats(res as any);
    expect(body).toEqual({
      githubStars: 984,
      dockerPulls: 32_456,
      workspaces: 3_871,
      toolCalls30d: 654_321,
      updatedAt: '2026-10-07T10:00:00.000Z',
    });
    expect(headers['Cache-Control']).toMatch(/public, max-age=\d+/);
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
