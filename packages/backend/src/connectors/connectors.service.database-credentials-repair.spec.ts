import { Logger } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { decrypt, encrypt } from '../common/crypto/encryption.util';

/**
 * The boot pass for DATABASE connectors saved before a password typed into
 * the connection string went to the encrypted authConfig (#1245): it moves
 * what a save would move, leaves the rest exactly as stored, and says nothing
 * secret in the log.
 */
describe('ConnectorsService.repairDatabaseUrlCredentials', () => {
  const KEY = 'k'.repeat(48);
  const seal = (authConfig: unknown) => encrypt(JSON.stringify(authConfig), KEY);
  const open = (value: string | null) => (value ? JSON.parse(decrypt(value, KEY)) : null);

  type Row = { id: string; type: string; baseUrl: string; authConfig: string | null };

  /** One stored row per shape of connection string, and what the pass makes of it. */
  const MOVED: Array<[label: string, row: Row, baseUrl: string, authConfig: Record<string, unknown>]> = [
    [
      'postgresql',
      { id: 'c-pg', type: 'DATABASE', baseUrl: 'postgresql://shopuser:s3cret-pg@db.example.com:5432/shop', authConfig: null },
      'postgresql://db.example.com:5432/shop',
      { username: 'shopuser', password: 's3cret-pg' },
    ],
    [
      'mysql',
      { id: 'c-mysql', type: 'DATABASE', baseUrl: 'mysql://shopuser:s3cret-my@db.example.com:3306/shop', authConfig: null },
      'mysql://db.example.com:3306/shop',
      { username: 'shopuser', password: 's3cret-my' },
    ],
    [
      'mssql, keeping the other authConfig keys',
      {
        id: 'c-mssql',
        type: 'DATABASE',
        baseUrl: 'mssql://shopuser:s3cret-ms@sql.example.com:1433/shop',
        authConfig: seal({ domain: 'CORP' }),
      },
      'mssql://sql.example.com:1433/shop',
      { domain: 'CORP', username: 'shopuser', password: 's3cret-ms' },
    ],
    [
      'mongodb with one host',
      {
        id: 'c-mongo',
        type: 'DATABASE',
        baseUrl: 'mongodb://shopuser:s3cret-mo@mongo.example.com:27017/shop?authSource=admin',
        authConfig: null,
      },
      'mongodb://mongo.example.com:27017/shop?authSource=admin',
      { username: 'shopuser', password: 's3cret-mo' },
    ],
    [
      'an @ inside the password',
      { id: 'c-at', type: 'DATABASE', baseUrl: 'postgresql://shopuser:p@ss@w0rd@db.example.com/shop', authConfig: null },
      'postgresql://db.example.com/shop',
      { username: 'shopuser', password: 'p@ss@w0rd' },
    ],
    [
      'URL-encoded characters',
      {
        id: 'c-enc',
        type: 'DATABASE',
        baseUrl: 'postgres://shop%2Buser:p%40ss%3Aw0rd%2F1@db.example.com/shop?sslmode=require',
        authConfig: null,
      },
      'postgres://db.example.com/shop?sslmode=require',
      { username: 'shop+user', password: 'p@ss:w0rd/1' },
    ],
  ];

  const LEFT: Array<[label: string, row: Row]> = [
    [
      'an ADO.NET string',
      { id: 'c-ado', type: 'DATABASE', baseUrl: 'Server=sql.example.com;User Id=shopuser;Password=s3cret@ado;', authConfig: null },
    ],
    [
      'a multi-host MongoDB URL',
      {
        id: 'c-multi',
        type: 'DATABASE',
        baseUrl: 'mongodb://shopuser:s3cret-rs@m1.example.com:27017,m2.example.com:27017/shop',
        authConfig: null,
      },
    ],
    [
      'an authConfig that already has a username',
      {
        id: 'c-both',
        type: 'DATABASE',
        baseUrl: 'postgresql://shopuser:s3cret-both@db.example.com/shop',
        authConfig: seal({ username: 'other' }),
      },
    ],
    [
      'a {{VAR}} password',
      { id: 'c-var', type: 'DATABASE', baseUrl: 'postgresql://shopuser:{{DB_PASSWORD}}@db.example.com/shop', authConfig: null },
    ],
  ];

  /** Never read: one has no `@`, the other is not a DATABASE connector. */
  const OUT_OF_SCOPE: Row[] = [
    { id: 'c-clean', type: 'DATABASE', baseUrl: 'postgresql://db.example.com:5432/shop', authConfig: seal({ username: 'shopuser', password: 's3cret-clean' }) },
    { id: 'c-rest', type: 'REST', baseUrl: 'https://shopuser:s3cret-rest@api.example.com', authConfig: null },
  ];

  /** Everything a log line must never carry. */
  const SECRETS = [
    'shopuser',
    'shop%2Buser',
    'shop+user',
    's3cret',
    'p@ss',
    'p%40ss',
    'w0rd',
    'example.com',
    '://',
    'DB_PASSWORD',
    'CORP',
  ];

  let rows: Row[];
  let prisma: {
    connector: { findMany: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  };
  let service: ConnectorsService;
  let logged: string[];

  const row = (id: string) => rows.find((r) => r.id === id)!;

  beforeEach(() => {
    rows = [...MOVED.map(([, r]) => r), ...LEFT.map(([, r]) => r), ...OUT_OF_SCOPE].map((r) => ({ ...r }));
    prisma = {
      connector: {
        // What the database does with the pass's filter and its guarded write.
        findMany: jest.fn(async ({ where }: any) =>
          rows
            .filter((r) => r.type === where.type && r.baseUrl.includes(where.baseUrl.contains))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(({ id, baseUrl, authConfig }) => ({ id, baseUrl, authConfig })),
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hit = rows.filter(
            (r) => r.id === where.id && r.baseUrl === where.baseUrl && r.authConfig === where.authConfig,
          );
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        }),
        // For update(), the path a user's own save takes.
        findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
        update: jest.fn(async ({ data }: any) => data),
      },
    };
    service = new ConnectorsService(
      prisma as any,
      { get: () => KEY } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(`${level}: ${args.map(String).join(' ')}`);
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads the candidates with one filtered query', async () => {
    await service.repairDatabaseUrlCredentials();

    expect(prisma.connector.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.connector.findMany.mock.calls[0][0].where).toEqual({
      type: 'DATABASE',
      baseUrl: { contains: '@' },
    });
  });

  it.each(MOVED)('moves the credentials of %s', async (_label, stored, baseUrl, authConfig) => {
    await service.repairDatabaseUrlCredentials();

    expect(row(stored.id).baseUrl).toBe(baseUrl);
    expect(open(row(stored.id).authConfig)).toEqual(authConfig);
    // Encrypted, not the JSON itself.
    expect(row(stored.id).authConfig).not.toContain(String(authConfig.password));
  });

  it.each(MOVED)('stores what opening Edit and saving would store: %s', async (_label, stored) => {
    await service.update(stored.id, { baseUrl: stored.baseUrl });
    const saved = prisma.connector.update.mock.calls[0][0].data;

    await service.repairDatabaseUrlCredentials();

    expect(row(stored.id).baseUrl).toBe(saved.baseUrl);
    expect(open(row(stored.id).authConfig)).toEqual(open(saved.authConfig));
  });

  it.each(LEFT)('leaves %s exactly as stored', async (_label, stored) => {
    await service.repairDatabaseUrlCredentials();

    expect(row(stored.id)).toEqual(stored);
    expect(prisma.connector.updateMany.mock.calls.map(([arg]) => arg.where.id)).not.toContain(stored.id);
  });

  it('touches nothing outside its filter', async () => {
    await service.repairDatabaseUrlCredentials();

    for (const stored of OUT_OF_SCOPE) expect(row(stored.id)).toEqual(stored);
  });

  it('reports what it moved and what it left, in one line with ids and counts', async () => {
    const result = await service.repairDatabaseUrlCredentials();

    expect(result).toEqual({
      moved: ['c-at', 'c-enc', 'c-mongo', 'c-mssql', 'c-mysql', 'c-pg'],
      leftAsIs: ['c-ado', 'c-both', 'c-multi', 'c-var'],
      failed: [],
    });
    expect(logged).toEqual([
      'log: Database connection strings: credentials of 6 connectors moved into the encrypted auth config ' +
        '(c-at, c-enc, c-mongo, c-mssql, c-mysql, c-pg); 4 left as is (c-ado, c-both, c-multi, c-var); 0 failed',
    ]);
  });

  it('changes nothing on a second run', async () => {
    await service.repairDatabaseUrlCredentials();
    const after = rows.map((r) => ({ ...r }));
    prisma.connector.updateMany.mockClear();

    const second = await service.repairDatabaseUrlCredentials();

    expect(prisma.connector.updateMany).not.toHaveBeenCalled();
    expect(rows).toEqual(after);
    expect(second.moved).toEqual([]);
    expect(second.failed).toEqual([]);
  });

  it('says so when there is nothing to do', async () => {
    rows = OUT_OF_SCOPE.map((r) => ({ ...r }));

    await service.repairDatabaseUrlCredentials();

    expect(prisma.connector.updateMany).not.toHaveBeenCalled();
    expect(logged).toEqual([
      'log: Database connection strings: credentials of 0 connectors moved into the encrypted auth config; ' +
        '0 left as is; 0 failed',
    ]);
  });

  it('goes on with the other rows when one write fails', async () => {
    const write = prisma.connector.updateMany.getMockImplementation()!;
    prisma.connector.updateMany.mockImplementation(async (arg: any) => {
      if (arg.where.id === 'c-mysql') {
        // A Prisma message quotes the arguments of the call.
        throw Object.assign(new Error(`Invalid invocation: where: { baseUrl: "${arg.where.baseUrl}" }`), {
          code: 'P2028',
        });
      }
      return write(arg);
    });
    const stored = { ...row('c-mysql') };

    const result = await service.repairDatabaseUrlCredentials();

    expect(result.failed).toEqual(['c-mysql']);
    expect(result.moved).toEqual(['c-at', 'c-enc', 'c-mongo', 'c-mssql', 'c-pg']);
    expect(row('c-mysql')).toEqual(stored);
    expect(logged).toEqual([
      'warn: Connector c-mysql: moving the connection string credentials failed (P2028), the connector is left as is',
      expect.stringMatching(/^warn: Database connection strings: credentials of 5 connectors moved .*; 1 failed \(c-mysql\)$/),
    ]);
  });

  it('never overwrites an authConfig it cannot decrypt', async () => {
    const unreadable = encrypt(JSON.stringify({ domain: 'CORP' }), 'x'.repeat(48));
    row('c-pg').authConfig = unreadable;
    const stored = { ...row('c-pg') };

    const result = await service.repairDatabaseUrlCredentials();

    expect(result.failed).toEqual(['c-pg']);
    expect(row('c-pg')).toEqual(stored);
    expect(result.moved).toContain('c-mysql');
  });

  it('leaves a row that was saved between the read and the write', async () => {
    const read = prisma.connector.findMany.getMockImplementation()!;
    prisma.connector.findMany.mockImplementation(async (arg: any) => {
      const found = await read(arg);
      // An edit lands after the pass has read the table.
      row('c-pg').baseUrl = 'postgresql://shopuser:s3cret-new@db2.example.com:5432/shop';
      return found;
    });

    const result = await service.repairDatabaseUrlCredentials();

    expect(result.leftAsIs).toContain('c-pg');
    expect(row('c-pg')).toEqual({
      id: 'c-pg',
      type: 'DATABASE',
      baseUrl: 'postgresql://shopuser:s3cret-new@db2.example.com:5432/shop',
      authConfig: null,
    });
  });

  it('does not throw when the query fails, and says only what kind of error it was', async () => {
    prisma.connector.findMany.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED postgresql://shopuser:s3cret@db.example.com'), { code: 'P1001' }),
    );

    await expect(service.repairDatabaseUrlCredentials()).resolves.toEqual({ moved: [], leftAsIs: [], failed: [] });
    expect(logged).toEqual(['error: Database connection strings not checked: P1001']);
  });

  it('logs no connection string, user name, password or host, whatever happens', async () => {
    // A run with every outcome: moved, left, an unreadable authConfig, a failed write.
    row('c-mongo').authConfig = encrypt(JSON.stringify({ domain: 'CORP' }), 'x'.repeat(48));
    const write = prisma.connector.updateMany.getMockImplementation()!;
    prisma.connector.updateMany.mockImplementation(async (arg: any) => {
      if (arg.where.id === 'c-at') throw new Error(`update failed for ${arg.where.baseUrl} -> ${arg.data.baseUrl}`);
      return write(arg);
    });

    const result = await service.repairDatabaseUrlCredentials();

    expect(result.failed).toEqual(['c-at', 'c-mongo']);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      for (const secret of SECRETS) expect(line).not.toContain(secret);
    }
  });

  it('caps the ids in the summary line', async () => {
    rows = Array.from({ length: 25 }, (_, i) => ({
      id: `c-${String(i).padStart(2, '0')}`,
      type: 'DATABASE',
      baseUrl: `postgresql://shopuser:s3cret-${i}@db.example.com/shop`,
      authConfig: null,
    }));

    await service.repairDatabaseUrlCredentials();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('credentials of 25 connectors moved');
    expect(logged[0]).toContain('c-19, and 5 more)');
    expect(logged[0]).not.toContain('c-20');
  });

  it('runs at start-up without holding it up, and a failure there cannot stop the boot', async () => {
    let release!: () => void;
    prisma.connector.findMany.mockImplementation(
      () => new Promise((_resolve, reject) => (release = () => reject(new Error('database gone')))),
    );

    // Returns at once, with the query still pending.
    expect(service.onApplicationBootstrap()).toBeUndefined();
    expect(prisma.connector.findMany).toHaveBeenCalledTimes(1);

    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toEqual(['error: Database connection strings not checked: Error']);
  });
});
