import { Client } from 'pg';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { Test } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { toolPerformanceQuery, ToolPerformanceRow } from './tool-performance.query';
import { ToolPerformanceQueryDto } from './tool-performance-query.dto';
import { MemberVisibilityService } from '../settings/member-visibility.service';

// All tables are connection-local TEMP tables; no application table is changed.
const databaseUrl = process.env.AUDIT_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('tool performance aggregation (PostgreSQL)', () => {
  const since = new Date('2026-11-03T12:00:00.000Z');
  const until = new Date('2026-11-04T12:00:00.000Z');
  let db: Client;
  let app: INestApplication;
  let endpoint: string;

  const query = async (options: ToolPerformanceQueryDto = {}, org = 'org-a') => {
    const sql = toolPerformanceQuery(org, since, until, options, options.limit ?? 25);
    return (await db.query<ToolPerformanceRow>(sql.text, sql.values)).rows;
  };

  const insert = async (
    id: string,
    tool: string,
    server: string | null,
    status: string,
    duration: number | null,
    repeats = 1,
    error: string | null = null,
    at = '2026-11-04T10:00:00',
  ) => {
    await db.query('INSERT INTO pg_temp.tool_invocations VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      id,
      tool,
      server,
      status,
      duration,
      repeats,
      error,
      at,
    ]);
  };

  beforeAll(async () => {
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query(`
      SET TIME ZONE 'Pacific/Honolulu';
      CREATE TEMP TABLE connectors (id text PRIMARY KEY, name text, organization_id text);
      CREATE TEMP TABLE mcp_tools (id text PRIMARY KEY, name text, connector_id text);
      CREATE TEMP TABLE mcp_server_configs (id text PRIMARY KEY, name text, organization_id text);
      CREATE TEMP TABLE tool_invocations (
        id text PRIMARY KEY, tool_id text, mcp_server_id text, status text,
        duration_ms integer, repeat_count integer, error text, created_at timestamp
      );
      INSERT INTO connectors VALUES ('c1', 'CRM', 'org-a'), ('c2', 'ERP', 'org-a'), ('secret-c', 'Secret connector', 'org-b');
      INSERT INTO mcp_tools VALUES ('t1', 'search', 'c1'), ('t2', 'search', 'c2'), ('secret-t', 'search', 'secret-c');
      INSERT INTO mcp_server_configs VALUES ('s1', 'Server one', 'org-a'), ('s2', 'Server two', 'org-a'), ('secret-s', 'Secret server', 'org-b');
    `);
    const module = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        AuditService,
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows,
          },
        },
        // Open workspace: the controller takes today's path. Restricted mode is
        // covered in audit.member-visibility.integration.spec.ts.
        { provide: MemberVisibilityService, useValue: { scopeFor: async () => ({ restricted: false }) } },
      ],
    })
      .overrideGuard(JwtOrManagementKeyGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest<{ user: { organizationId: string } }>().user = {
            organizationId: 'org-a',
          };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    endpoint = `${await app.getUrl()}/api/audit/tool-performance`;
  });

  beforeEach(async () => {
    await db.query('TRUNCATE pg_temp.tool_invocations');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('serves the authenticated organization through HTTP, SQL, and the response mapper', async () => {
    const at = new Date(Date.now() - 60_000);
    const timestamp = at.toISOString().slice(0, -1);
    await insert('a', 't1', 's1', 'SUCCESS', 10, 1, null, timestamp);
    await insert('b', 't1', 's1', 'TIMEOUT', 50, 3, 'Timed out', timestamp);
    await insert('c', 'secret-t', 'secret-s', 'ERROR', 999, 20, 'Secret error', timestamp);

    const response = await fetch(
      `${endpoint}?hours=24&connectorId=c1&mcpServerId=s1&limit=1&offset=0`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hasMore).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      toolId: 't1',
      connectorName: 'CRM',
      mcpServerName: 'Server one',
      calls: 4,
      errors: 3,
      errorRate: 75,
      latencySampleCount: 2,
      p50Ms: 30,
      p95Ms: 48,
      lastError: 'Timed out',
      lastErrorAt: at.toISOString(),
    });
    expect(body.items[0].p99Ms).toBeCloseTo(49.6);
  });

  it('rejects invalid query ranges and caller-supplied organization scope over HTTP', async () => {
    expect((await fetch(`${endpoint}?hours=2161`)).status).toBe(400);
    expect((await fetch(`${endpoint}?organizationId=org-b`)).status).toBe(400);
  });

  it('weights ERROR and TIMEOUT counts without inventing latency samples', async () => {
    await insert('a', 't1', 's1', 'SUCCESS', 0);
    await insert('b', 't1', 's1', 'ERROR', 100, 9, 'Rate limited');
    await insert('c', 't1', 's1', 'TIMEOUT', 200, 3, 'Timed out');
    await insert('d', 't1', 's1', 'SUCCESS', 300);
    await insert('e', 't1', 's1', 'ERROR', null, 2);

    const [row] = await query();
    expect(Number(row.calls)).toBe(16);
    expect(Number(row.errors)).toBe(14);
    expect(Number(row.latency_sample_count)).toBe(4);
    expect(row.latency).toEqual([150, 285, 297]);
  });

  it('keeps zero and unknown durations distinct', async () => {
    await insert('a', 't1', null, 'SUCCESS', 0);
    await insert('b', 't1', 's1', 'SUCCESS', null);

    const rows = await query();
    expect(rows.find((row) => row.mcp_server_id === null)?.latency).toEqual([0, 0, 0]);
    expect(rows.find((row) => row.mcp_server_id === 's1')).toMatchObject({ latency: null });
    expect(Number(rows.find((row) => row.mcp_server_id === 's1')?.latency_sample_count)).toBe(0);
  });

  it('separates same-name tools and server identities, with filters applied before aggregation', async () => {
    await insert('a', 't1', null, 'SUCCESS', 0);
    await insert('b', 't1', 's1', 'SUCCESS', 100);
    await insert('c', 't1', 's2', 'SUCCESS', 200);
    await insert('d', 't2', 's1', 'SUCCESS', 300);

    expect(await query()).toHaveLength(4);
    const rows = await query({ connectorId: 'c1', mcpServerId: 's1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool_id: 't1',
      connector_name: 'CRM',
      mcp_server_name: 'Server one',
      latency: [100, 100, 100],
    });
  });

  it('does not expose another tenant through tools, server names, or filter values', async () => {
    await insert('a', 't1', 's1', 'SUCCESS', 10);
    await insert('b', 'secret-t', 'secret-s', 'ERROR', 999, 20, 'Secret error');
    await insert('c', 't1', 'secret-s', 'ERROR', 999, 20, 'Misattributed server');

    expect(await query()).toHaveLength(1);
    expect(await query({ connectorId: 'secret-c' })).toEqual([]);
    expect(await query({ mcpServerId: 'secret-s' })).toEqual([]);
    expect(await query({ connectorId: "c1' OR 1=1 --" })).toEqual([]);
    expect((await query({}, 'org-b'))[0]).toMatchObject({
      connector_name: 'Secret connector',
      last_error: 'Secret error',
    });
  });

  it('returns the last recorded nonempty failure with deterministic timestamp ties', async () => {
    await insert('a', 't1', 's1', 'ERROR', 10, 1, 'Earlier', '2026-11-04T09:00:00');
    await insert('b', 't1', 's1', 'ERROR', 10, 1, 'Same time, lower id');
    await insert('c', 't1', 's1', 'TIMEOUT', 10, 1, 'Last recorded');
    await insert('d', 't1', 's1', 'ERROR', 10, 1, null, '2026-11-04T11:00:00');
    await insert('e', 't1', 's1', 'ERROR', 10, 1, '', '2026-11-04T11:00:00');
    await insert('f', 't1', 's1', 'SUCCESS', 10, 1, 'Not a failure', '2026-11-04T11:30:00');

    const [row] = await query();
    expect(row.last_error).toBe('Last recorded');
    expect(row.last_error_at?.toISOString()).toBe('2026-11-04T10:00:00.000Z');
  });

  it('uses a half-open UTC window regardless of the database time zone', async () => {
    await insert('before', 't1', 's1', 'SUCCESS', 1, 1, null, '2026-11-03T11:59:59.999');
    await insert('start', 't1', 's1', 'SUCCESS', 10, 1, null, '2026-11-03T12:00:00');
    await insert('end', 't1', 's1', 'ERROR', 999, 100, 'Outside the window', '2026-11-04T12:00:00');

    const [row] = await query();
    expect(Number(row.calls)).toBe(1);
    expect(row.latency).toEqual([10, 10, 10]);
    expect(row.last_error).toBeNull();
  });

  it('pages groups in a stable order and fetches only one lookahead group', async () => {
    await insert('a', 't1', 's1', 'SUCCESS', 10);
    await insert('b', 't1', null, 'SUCCESS', 20);
    await insert('c', 't2', null, 'SUCCESS', 30);

    const first = await query({ limit: 1 });
    expect(first.map((row) => row.mcp_server_id)).toEqual([null, 's1']);
    const second = await query({ limit: 1, offset: 1 });
    expect(second.map((row) => row.tool_id)).toEqual(['t1', 't2']);
    expect(await query({ offset: 3 })).toEqual([]);
  });
});
