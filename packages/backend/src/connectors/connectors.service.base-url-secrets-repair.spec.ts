import { Logger } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { openEnvVars, openEnvVarsStrict, sealEnvVars } from '../common/crypto/env-vars-at-rest';
import { encrypt } from '../common/crypto/encryption.util';
import { interpolateConnectorConfig } from '../common/env-interpolation.util';
import { isSecretName } from './connector-secrets.util';

/**
 * The boot pass for HTTP connectors whose base URL still carries a secret
 * (a webhook token, a key, `user:password@`): it moves what a save would
 * move into an encrypted variable, leaves `{{VAR}}` in the URL so calls are
 * unchanged, and says nothing secret in the log.
 */
describe('ConnectorsService.repairBaseUrlSecrets', () => {
  const KEY = 'k'.repeat(48);
  const BITRIX = ['k2bx', 'a8g5', 'n4gh', 'vqgo'].join('');
  const SLACK = ['AbCdEfGh', 'IjKlMnOp', 'QrStUv12'].join('');
  const TG = `7123456789:${['AAH', 'k3jd9QwErTyUiOp', 'AsDfGhJkLzXcVbN', 'm12'].join('')}`;
  const OPAQUE = 'q8ZtW3nRk2LxV9pMbH4cJs7YdF6gTe1A';
  const MCP_KEY = 'k3y4bc12def9';
  const PASSWORD = 'Pa55w0rd-1';

  type Row = {
    id: string;
    name: string;
    type: string;
    baseUrl: string;
    config: Record<string, unknown> | null;
    /** As stored: sealed, plain, or null. */
    envVars: unknown;
    updatedAt: Date;
  };

  const at = new Date('2026-11-01T10:00:00.000Z');
  const make = (r: Omit<Row, 'updatedAt' | 'config' | 'envVars'> & Partial<Row>): Row => ({
    config: null,
    envVars: null,
    updatedAt: at,
    ...r,
  });

  /** Stored row, the base URL it ends with, and the variables it then has. */
  const MOVED: Array<[label: string, row: () => Row, baseUrl: string, envVars: Record<string, unknown>]> = [
    [
      'a Bitrix24 webhook URL',
      () => make({ id: 'c-bitrix', name: 'Bitrix CRM', type: 'REST', baseUrl: `https://portal.bitrix24.com/rest/1/${BITRIX}/` }),
      'https://portal.bitrix24.com/rest/1/{{BITRIX_CRM_WEBHOOK_TOKEN}}/',
      { BITRIX_CRM_WEBHOOK_TOKEN: BITRIX },
    ],
    [
      'a Slack webhook URL, keeping the variables it has',
      () =>
        make({
          id: 'c-slack',
          name: 'Alerts',
          type: 'REST',
          baseUrl: `https://hooks.slack.com/services/T0A1B2C3D/B0E1F2G3H/${SLACK}`,
          envVars: sealEnvVars({ CHANNEL: 'general', LIMIT: 5 }),
        }),
      'https://hooks.slack.com/services/T0A1B2C3D/B0E1F2G3H/{{ALERTS_WEBHOOK_TOKEN}}',
      { CHANNEL: 'general', LIMIT: 5, ALERTS_WEBHOOK_TOKEN: SLACK },
    ],
    [
      'a key in an MCP server URL',
      () => make({ id: 'c-mcp', name: 'Gateway', type: 'MCP', baseUrl: `https://mcp.example.com/mcp?api_key=${MCP_KEY}` }),
      'https://mcp.example.com/mcp?api_key={{GATEWAY_API_KEY}}',
      { GATEWAY_API_KEY: MCP_KEY },
    ],
    [
      'user:password@ in an OData URL, with plain stored variables',
      () =>
        make({
          id: 'c-odata',
          name: 'ERP',
          type: 'ODATA',
          baseUrl: `https://svc:${PASSWORD}@erp.example.com/odata/`,
          envVars: { COMPANY: 'acme' },
        }),
      'https://svc:{{ERP_PASSWORD}}@erp.example.com/odata/',
      { COMPANY: 'acme', ERP_PASSWORD: PASSWORD },
    ],
    [
      'a Telegram token a variable already holds',
      () =>
        make({
          id: 'c-reuse',
          name: 'Bot',
          type: 'REST',
          baseUrl: `https://api.telegram.org/bot${TG}`,
          envVars: sealEnvVars({ TELEGRAM_BOT_TOKEN: TG }),
        }),
      'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}',
      { TELEGRAM_BOT_TOKEN: TG },
    ],
  ];

  /** Never written: clean, references, the left-out heuristic, another type. */
  const UNTOUCHED: Array<() => Row> = [
    () => make({ id: 'c-clean', name: 'Clean', type: 'REST', baseUrl: 'https://api.example.com/v1' }),
    () =>
      make({
        id: 'c-ref',
        name: 'Ref',
        type: 'REST',
        baseUrl: 'https://portal.bitrix24.com/rest/1/{{B_WEBHOOK_TOKEN}}/',
        envVars: sealEnvVars({ B_WEBHOOK_TOKEN: BITRIX }),
      }),
    () => make({ id: 'c-entropy', name: 'Opaque', type: 'REST', baseUrl: `https://api.example.com/hooks/${OPAQUE}` }),
    () => make({ id: 'c-db', name: 'Db', type: 'DATABASE', baseUrl: `postgresql://u:${PASSWORD}@db.example.com/x` }),
  ];

  const SECRETS = [BITRIX, SLACK, TG.split(':')[1], MCP_KEY, PASSWORD, 'portal.bitrix24.com', '://'];

  let rows: Row[];
  let prisma: { connector: { findMany: jest.Mock; updateMany: jest.Mock }; $queryRaw: jest.Mock };
  let service: ConnectorsService;
  let logged: string[];
  const row = (id: string) => rows.find((r) => r.id === id)!;
  const envOf = (id: string) => openEnvVarsStrict(row(id).envVars);

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
    rows = [...MOVED.map(([, r]) => r()), ...UNTOUCHED.map((r) => r())];
    prisma = {
      connector: {
        findMany: jest.fn(async ({ where }: any) =>
          rows
            .filter((r) => where.type.in.includes(r.type))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(({ id, name, type, baseUrl, config, updatedAt }) => ({ id, name, type, baseUrl, config, updatedAt })),
        ),
        // The guarded write, with the at-rest extension's encryption.
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hit = rows.filter(
            (r) => r.id === where.id && r.baseUrl === where.baseUrl && r.updatedAt.getTime() === where.updatedAt.getTime(),
          );
          for (const r of hit) {
            Object.assign(r, data, { updatedAt: new Date(r.updatedAt.getTime() + 1000) });
            if ('envVars' in data) r.envVars = sealEnvVars(data.envVars);
          }
          return { count: hit.length };
        }),
      },
      $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ids: string[]) =>
        rows.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, env_vars: r.envVars })),
      ),
    };
    service = new ConnectorsService(prisma as any, { get: () => KEY } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(`${level}: ${args.map(String).join(' ')}`);
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads the HTTP connectors, and the variables of the candidates only', async () => {
    await service.repairBaseUrlSecrets();

    expect(prisma.connector.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.connector.findMany.mock.calls[0][0].where.type.in.sort()).toEqual(['GRAPHQL', 'MCP', 'ODATA', 'REST', 'SOAP']);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect([...prisma.$queryRaw.mock.calls[0][1]].sort()).toEqual(['c-bitrix', 'c-mcp', 'c-odata', 'c-reuse', 'c-slack']);
  });

  it.each(MOVED)('moves %s into an encrypted variable', async (_label, stored, baseUrl, envVars) => {
    const id = stored().id;
    await service.repairBaseUrlSecrets();

    expect(row(id).baseUrl).toBe(baseUrl);
    expect(envOf(id)).toEqual(envVars);
    // Encrypted at rest, and named so that the dashboard masks it.
    for (const value of Object.values(envVars)) {
      if (typeof value === 'string') expect(JSON.stringify(row(id).envVars)).not.toContain(value);
    }
    for (const name of Object.keys(envVars)) {
      if (!['CHANNEL', 'LIMIT', 'COMPANY'].includes(name)) expect(isSecretName(name)).toBe(true);
    }
  });

  it.each(MOVED)('keeps the URL a call sends for %s', async (_label, stored) => {
    const before = stored().baseUrl;
    const id = stored().id;
    await service.repairBaseUrlSecrets();

    const { config } = interpolateConnectorConfig(
      { baseUrl: row(id).baseUrl },
      { method: 'GET', path: '/' },
      openEnvVars(row(id).envVars) as Record<string, string>,
    );
    expect(config.baseUrl).toBe(before);
  });

  it('does not rewrite the variables when one already holds the secret', async () => {
    const sealed = row('c-reuse').envVars;
    await service.repairBaseUrlSecrets();

    const call = prisma.connector.updateMany.mock.calls.find(([arg]) => arg.where.id === 'c-reuse')![0];
    expect(call.data).toEqual({ baseUrl: 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}' });
    expect(row('c-reuse').envVars).toBe(sealed);
  });

  it('cleans the install-time baseline of a catalog connector with the same variable', async () => {
    const url = `https://portal.bitrix24.com/rest/1/${BITRIX}/`;
    row('c-bitrix').config = { adapterSlug: 'acme-crm', baseUrlBaseline: url, adapterVersion: '1.0.0' };

    await service.repairBaseUrlSecrets();

    expect(row('c-bitrix').config).toEqual({
      adapterSlug: 'acme-crm',
      baseUrlBaseline: 'https://portal.bitrix24.com/rest/1/{{BITRIX_CRM_WEBHOOK_TOKEN}}/',
      adapterVersion: '1.0.0',
    });
    expect(Object.keys(envOf('c-bitrix')!)).toEqual(['BITRIX_CRM_WEBHOOK_TOKEN']);
  });

  it('leaves everything else exactly as stored', async () => {
    const before = UNTOUCHED.map((r) => ({ ...row(r().id) }));
    await service.repairBaseUrlSecrets();

    for (const stored of before) expect(row(stored.id)).toEqual(stored);
    const written = prisma.connector.updateMany.mock.calls.map(([arg]) => arg.where.id);
    expect(written).toEqual(expect.not.arrayContaining(before.map((r) => r.id)));
  });

  it('reports what it moved in one line with ids and counts', async () => {
    const result = await service.repairBaseUrlSecrets();

    expect(result).toEqual({
      moved: ['c-bitrix', 'c-mcp', 'c-odata', 'c-reuse', 'c-slack'],
      leftAsIs: [],
      failed: [],
    });
    expect(logged).toEqual([
      'log: Base URL secrets: secrets of 5 connectors moved into encrypted variables ' +
        '(c-bitrix, c-mcp, c-odata, c-reuse, c-slack); 0 left as is; 0 failed',
    ]);
  });

  it('changes nothing on a second run', async () => {
    await service.repairBaseUrlSecrets();
    const after = rows.map((r) => ({ ...r }));
    prisma.connector.updateMany.mockClear();
    prisma.$queryRaw.mockClear();

    const second = await service.repairBaseUrlSecrets();

    expect(prisma.connector.updateMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(rows).toEqual(after);
    expect(second).toEqual({ moved: [], leftAsIs: [], failed: [] });
    expect(logged.at(-1)).toBe(
      'log: Base URL secrets: secrets of 0 connectors moved into encrypted variables; 0 left as is; 0 failed',
    );
  });

  it('never writes a row whose variables it cannot decrypt', async () => {
    row('c-slack').envVars = { $enc: encrypt(JSON.stringify({ CHANNEL: 'general' }), 'x'.repeat(48), 'connectors.env_vars') };
    const stored = { ...row('c-slack') };

    const result = await service.repairBaseUrlSecrets();

    expect(result.failed).toEqual(['c-slack']);
    expect(row('c-slack')).toEqual(stored);
    expect(result.moved).toContain('c-bitrix');
    expect(logged.at(-1)).toMatch(/^warn: Base URL secrets: .*; 1 failed \(c-slack\)$/);
  });

  it('leaves a row that was saved between the read and the write', async () => {
    const read = prisma.connector.findMany.getMockImplementation()!;
    prisma.connector.findMany.mockImplementation(async (arg: any) => {
      const found = await read(arg);
      row('c-bitrix').updatedAt = new Date(at.getTime() + 5000);
      row('c-bitrix').envVars = sealEnvVars({ EDITED: 'yes' });
      return found;
    });

    const result = await service.repairBaseUrlSecrets();

    expect(result.leftAsIs).toEqual(['c-bitrix']);
    expect(row('c-bitrix').baseUrl).toBe(`https://portal.bitrix24.com/rest/1/${BITRIX}/`);
    expect(envOf('c-bitrix')).toEqual({ EDITED: 'yes' });
  });

  it('goes on with the other rows when one write fails', async () => {
    const write = prisma.connector.updateMany.getMockImplementation()!;
    prisma.connector.updateMany.mockImplementation(async (arg: any) => {
      if (arg.where.id === 'c-mcp') {
        // A Prisma message quotes the arguments of the call.
        throw Object.assign(new Error(`Invalid invocation: where: { baseUrl: "${arg.where.baseUrl}" }`), { code: 'P2028' });
      }
      return write(arg);
    });

    const result = await service.repairBaseUrlSecrets();

    expect(result.failed).toEqual(['c-mcp']);
    expect(result.moved).toEqual(['c-bitrix', 'c-odata', 'c-reuse', 'c-slack']);
    expect(row('c-mcp').baseUrl).toBe(`https://mcp.example.com/mcp?api_key=${MCP_KEY}`);
    expect(logged[0]).toBe(
      'warn: Connector c-mcp: moving the secret in its base URL failed (P2028), the connector is left as is',
    );
  });

  it('does not throw when the query fails, and says only what kind of error it was', async () => {
    prisma.connector.findMany.mockRejectedValue(
      Object.assign(new Error(`connect failed https://portal.bitrix24.com/rest/1/${BITRIX}/`), { code: 'P1001' }),
    );

    await expect(service.repairBaseUrlSecrets()).resolves.toEqual({ moved: [], leftAsIs: [], failed: [] });
    expect(logged).toEqual(['error: Base URL secrets not checked: P1001']);
  });

  it('runs at start-up after the database pass, without holding the start up', async () => {
    const read = prisma.connector.findMany.getMockImplementation()!;
    const order: string[] = [];
    prisma.connector.findMany.mockImplementation(async (arg: any) => {
      // The database pass filters on one type; this pass on a list.
      if (typeof arg.where.type === 'string') {
        order.push('database');
        return [];
      }
      order.push('base url');
      return read(arg);
    });

    expect(service.onApplicationBootstrap()).toBeUndefined();
    expect(order).toEqual(['database']);
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(['database', 'base url']);
    expect(row('c-bitrix').baseUrl).toBe('https://portal.bitrix24.com/rest/1/{{BITRIX_CRM_WEBHOOK_TOKEN}}/');
  });

  it('logs no URL, host or secret, whatever happens', async () => {
    row('c-slack').envVars = { $enc: encrypt('{}', 'x'.repeat(48), 'connectors.env_vars') };
    const write = prisma.connector.updateMany.getMockImplementation()!;
    prisma.connector.updateMany.mockImplementation(async (arg: any) => {
      if (arg.where.id === 'c-odata') throw new Error(`update failed for ${arg.where.baseUrl} -> ${arg.data.baseUrl}`);
      return write(arg);
    });

    await service.repairBaseUrlSecrets();

    const text = logged.join('\n');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});
