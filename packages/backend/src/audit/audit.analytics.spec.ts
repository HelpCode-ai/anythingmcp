import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AnalyticsGroupRow, AuditService, analyticsQuery } from './audit.service';
import { ANALYTICS_MAX_DAYS, AnalyticsQueryDto } from './analytics-query.dto';

/** getAnalytics aggregates in Postgres; $queryRaw is mocked with its group rows. */
describe('AuditService.getAnalytics', () => {
  const NOW = new Date('2026-10-23T14:27:00.000Z');
  let service: AuditService;
  let queryRaw: jest.Mock;

  const day = (d: string, r: Partial<AnalyticsGroupRow>): AnalyticsGroupRow => ({
    by_tool: 0,
    day: d,
    tool_name: null,
    calls: 0n,
    success: 0n,
    error: 0n,
    timeout: 0n,
    duration: 0n,
    row_count: 0n,
    first_at: new Date(`${d}T00:00:00.000Z`),
    ...r,
  });
  const tool = (name: string, r: Partial<AnalyticsGroupRow>): AnalyticsGroupRow => ({
    by_tool: 1,
    day: null,
    tool_name: name,
    calls: 0n,
    success: 0n,
    error: 0n,
    timeout: 0n,
    duration: 0n,
    row_count: 0n,
    first_at: NOW,
    ...r,
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setInterval', 'clearInterval'] });
    queryRaw = jest.fn().mockResolvedValue([]);
    service = new AuditService({ $queryRaw: queryRaw } as any);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await service.onModuleDestroy();
  });

  it('keeps the response shape and numbers of the in-memory version', async () => {
    queryRaw.mockResolvedValue([
      // The partial UTC day the 7-day window starts on: in the totals, not in `daily`.
      day('2026-10-16', { calls: 2n, success: 2n, duration: 100n, row_count: 2n }),
      // 3 stored rows standing for 5 calls (a failure repeated 3 times).
      day('2026-10-20', { calls: 5n, success: 2n, error: 3n, duration: 900n, row_count: 3n }),
      day('2026-10-23', { calls: 4n, success: 3n, timeout: 1n, duration: 1001n, row_count: 4n }),
      tool('crm_search', { calls: 6n, error: 3n, duration: 1200n, row_count: 4n }),
      tool('erp_order', { calls: 5n, error: 0n, duration: 801n, row_count: 5n }),
    ]);

    const result = await service.getAnalytics('org-1', 7);

    expect(result).toEqual({
      daily: [
        { date: '2026-10-17', success: 0, error: 0, timeout: 0, avgDuration: 0 },
        { date: '2026-10-18', success: 0, error: 0, timeout: 0, avgDuration: 0 },
        { date: '2026-10-19', success: 0, error: 0, timeout: 0, avgDuration: 0 },
        // Per day the average is per stored row: 900 / 3.
        { date: '2026-10-20', success: 2, error: 3, timeout: 0, avgDuration: 300 },
        { date: '2026-10-21', success: 0, error: 0, timeout: 0, avgDuration: 0 },
        { date: '2026-10-22', success: 0, error: 0, timeout: 0, avgDuration: 0 },
        { date: '2026-10-23', success: 3, error: 0, timeout: 1, avgDuration: 250 },
      ],
      // Per tool the average is per call: 1200 / 6 and 801 / 5.
      topTools: [
        { name: 'crm_search', count: 6, errors: 3, avgDuration: 200 },
        { name: 'erp_order', count: 5, errors: 0, avgDuration: 160 },
      ],
      totalInvocations: 11,
      successRate: Math.round((7 / 11) * 100),
      // Whole window: 2001 ms over 9 stored rows.
      avgDuration: 222,
    });
  });

  it('returns the 10 most used tools, ties in the order they were first called', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      tool(`tool_${i}`, {
        calls: BigInt(i === 3 || i === 7 ? 50 : i),
        row_count: 1n,
        first_at: new Date(NOW.getTime() - (i === 7 ? 9_000 : 1_000)),
      }),
    );
    queryRaw.mockResolvedValue(rows);

    const { topTools } = await service.getAnalytics('org-1', 7);

    expect(topTools.map((t) => t.name)).toEqual([
      'tool_7', // tied with tool_3 at 50 but called first
      'tool_3',
      'tool_11',
      'tool_10',
      'tool_9',
      'tool_8',
      'tool_6',
      'tool_5',
      'tool_4',
      'tool_2',
    ]);
  });

  it('returns zeros, not NaN, for an empty window', async () => {
    const result = await service.getAnalytics('org-1', 30);

    expect(result.daily).toHaveLength(30);
    expect(result.daily[29].date).toBe('2026-10-23');
    expect(result).toMatchObject({ topTools: [], totalInvocations: 0, successRate: 0, avgDuration: 0 });
  });

  it('runs one parameterised query scoped to the organisation and the window', async () => {
    await service.getAnalytics('org-1', 7);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0][0];
    expect(sql.values).toEqual(['org-1', '2026-10-16T14:27:00.000Z']);
    expect(sql.text).toMatch(/c\.organization_id = \$1/);
    expect(sql.text).toMatch(/ti\.created_at >= \(\$2::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(sql.text).toMatch(/GROUPING SETS \(\(day\), \(tool_name\)\)/);
    expect(sql.text).not.toContain('org-1');
  });

  it(`caps the window at ${ANALYTICS_MAX_DAYS} days and defaults bad values to 7`, async () => {
    const result = await service.getAnalytics('org-1', 365);
    expect(result.daily).toHaveLength(ANALYTICS_MAX_DAYS);
    expect(queryRaw.mock.calls[0][0].values[1]).toBe(
      new Date(NOW.getTime() - ANALYTICS_MAX_DAYS * 86_400_000).toISOString(),
    );

    expect((await service.getAnalytics('org-1', NaN)).daily).toHaveLength(7);
    expect((await service.getAnalytics('org-1', 0)).daily).toHaveLength(7);
    expect((await service.getAnalytics('org-1', -4)).daily).toHaveLength(1);
  });

  it('never queries without an organisation', async () => {
    const result = await service.getAnalytics('', 7);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(result.totalInvocations).toBe(0);
    expect(result.daily).toHaveLength(7);
  });

  it('builds the SQL with the organisation as a bound value', () => {
    const sql = analyticsQuery("x' OR 1=1 --", new Date(NOW));
    expect(sql.values[0]).toBe("x' OR 1=1 --");
    expect(sql.text).not.toContain('OR 1=1');
  });
});

describe('AnalyticsQueryDto', () => {
  const check = (query: Record<string, unknown>) => {
    const dto = plainToInstance(AnalyticsQueryDto, query);
    return { dto, errors: validateSync(dto) };
  };

  it('accepts the ranges the dashboard offers and no value at all', () => {
    for (const days of ['7', '30', '90']) {
      const { dto, errors } = check({ days });
      expect(errors).toHaveLength(0);
      expect(dto.days).toBe(Number(days));
    }
    expect(check({}).errors).toHaveLength(0);
    expect(check({}).dto.days).toBeUndefined();
  });

  it(`rejects windows over ${ANALYTICS_MAX_DAYS} days, under 1 day and non-integers`, () => {
    for (const days of ['91', '365', '0', '-1', '7.5', 'abc']) {
      expect(check({ days }).errors).not.toHaveLength(0);
    }
  });
});
