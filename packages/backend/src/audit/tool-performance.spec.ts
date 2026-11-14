import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from './audit.service';
import { ToolPerformanceQueryDto } from './tool-performance-query.dto';
import { ToolPerformanceRow } from './tool-performance.query';

describe('AuditService.getToolPerformance', () => {
  const NOW = new Date('2026-11-04T12:00:00.000Z');
  let module: TestingModule;
  let service: AuditService;
  let queryRaw: jest.Mock<Promise<ToolPerformanceRow[]>, [Prisma.Sql]>;

  const row = (overrides: Partial<ToolPerformanceRow> = {}): ToolPerformanceRow => ({
    tool_id: 'tool-1',
    tool_name: 'search',
    connector_id: 'connector-1',
    connector_name: 'CRM',
    mcp_server_id: null,
    mcp_server_name: null,
    calls: 4n,
    errors: 3n,
    latency_sample_count: 2n,
    latency: [0, 95, 99],
    last_error: 'Request timed out',
    last_error_at: NOW,
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setInterval', 'clearInterval'] });
    queryRaw = jest.fn<Promise<ToolPerformanceRow[]>, [Prisma.Sql]>().mockResolvedValue([]);
    module = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: { $queryRaw: queryRaw } }],
    }).compile();
    service = module.get(AuditService);
  });

  afterEach(async () => {
    await module.close();
    jest.useRealTimers();
  });

  it('returns JSON-safe counts, failure percentages, and nullable stored-sample latencies', async () => {
    queryRaw.mockResolvedValue([
      row(),
      row({
        tool_id: 'tool-2',
        latency: null,
        latency_sample_count: 0n,
        last_error: null,
        last_error_at: null,
      }),
    ]);

    const result = await service.getToolPerformance('org-1');

    expect(result.items[0]).toEqual({
      toolId: 'tool-1',
      toolName: 'search',
      connectorId: 'connector-1',
      connectorName: 'CRM',
      mcpServerId: null,
      mcpServerName: null,
      calls: 4,
      errors: 3,
      errorRate: 75,
      latencySampleCount: 2,
      p50Ms: 0,
      p95Ms: 95,
      p99Ms: 99,
      lastError: 'Request timed out',
      lastErrorAt: NOW.toISOString(),
    });
    expect(result.items[1]).toMatchObject({
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      latencySampleCount: 0,
      lastError: null,
      lastErrorAt: null,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.hasMore).toBe(false);
  });

  it('uses a bounded rolling 24-hour UTC window by default', async () => {
    await service.getToolPerformance('org-1');

    const sql = queryRaw.mock.calls[0][0];
    expect(sql.values).toContain('2026-11-03T12:00:00.000Z');
    expect(sql.values).toContain(NOW.toISOString());
  });

  it('binds filter values instead of interpolating them into SQL', async () => {
    const connectorId = "connector' OR 1=1 --";
    await service.getToolPerformance('org-1', {
      hours: 1,
      connectorId,
      mcpServerId: 'server-1',
    });

    const sql = queryRaw.mock.calls[0][0];
    expect(sql.values).toContain('2026-11-04T11:00:00.000Z');
    expect(sql.values).toContain(connectorId);
    expect(sql.values).toContain('server-1');
    expect(sql.text).not.toContain(connectorId);
  });

  it('uses the extra group only to report the next page', async () => {
    queryRaw.mockResolvedValue([row(), row({ tool_id: 'tool-2' })]);
    const result = await service.getToolPerformance('org-1', { limit: 1 });
    expect(result.items.map((item) => item.toolId)).toEqual(['tool-1']);
    expect(result.hasMore).toBe(true);
  });

  it('does not query without an organization', async () => {
    expect(await service.getToolPerformance('')).toEqual({ items: [], hasMore: false });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('ToolPerformanceQueryDto', () => {
  const validate = (input: Record<string, unknown>) =>
    validateSync(plainToInstance(ToolPerformanceQueryDto, input));

  it('accepts defaults, filters, and the boundary values', () => {
    expect(validate({})).toEqual([]);
    expect(
      validate({ hours: '2160', limit: '100', offset: '0', connectorId: 'c1', mcpServerId: 's1' }),
    ).toEqual([]);
  });

  it.each([
    { hours: '0' },
    { hours: '2161' },
    { hours: '1.5' },
    { hours: 'abc' },
    { hours: ['1', '24'] },
    { limit: '0' },
    { limit: '101' },
    { offset: '-1' },
    { offset: '0.5' },
    { offset: '9007199254740992' },
    { connectorId: ['c1', 'c2'] },
    { connectorId: '' },
    { mcpServerId: 'x'.repeat(129) },
  ])('rejects invalid query values: %j', (input) => {
    expect(validate(input)).not.toHaveLength(0);
  });
});
