import { DatabaseEngine, normalizeDeniedTables } from './database.engine';
import * as hanaDriver from './hana.driver';

jest.mock('../../common/ssrf.util', () => ({
  assertSafeOutboundHost: jest.fn().mockResolvedValue(undefined),
}));

function fakeSession(result: Partial<hanaDriver.HanaQueryResult> = {}) {
  const calls: string[] = [];
  const session: hanaDriver.HanaSession & { calls: string[]; query: jest.Mock } = {
    calls,
    run: jest.fn(async (sql: string) => {
      calls.push(sql);
    }),
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      return { rows: [], truncated: false, ...result };
    }),
    close: jest.fn(async () => undefined),
  };
  return session;
}

describe('DatabaseEngine — SAP HANA', () => {
  let engine: DatabaseEngine;
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    engine = new DatabaseEngine();
    openSpy = jest.spyOn(hanaDriver, 'openHanaSession');
  });

  afterEach(() => {
    openSpy.mockRestore();
    delete process.env.HANA_DRIVER;
  });

  describe('buildHanaConfig', () => {
    it('reads tenant, schema, client and credentials', () => {
      const cfg = engine.buildHanaConfig({
        baseUrl:
          'hana://hana.example.test:30015/?databaseName=QAS&currentSchema=SAPHANADB&sapClient=100',
        authConfig: { username: 'AMCP_READER', password: 'secret' },
      });
      expect(cfg).toEqual({
        driver: 'hdb',
        connect: {
          host: 'hana.example.test',
          port: 30015,
          user: 'AMCP_READER',
          password: 'secret',
          databaseName: 'QAS',
          encrypt: true,
          validateCertificate: true,
        },
        currentSchema: 'SAPHANADB',
        sapClient: '100',
        timeoutSeconds: 60,
      });
    });

    it('takes the tenant from the path and honours TLS switches and driver', () => {
      const cfg = engine.buildHanaConfig({
        baseUrl:
          'saphana://h.example.test:30013/QAS?encrypt=false&sslValidateCertificate=false&driver=hana-client&statementTimeout=5000',
      });
      expect(cfg.connect.databaseName).toBe('QAS');
      expect(cfg.connect.port).toBe(30013);
      expect(cfg.connect.encrypt).toBe(false);
      expect(cfg.connect.validateCertificate).toBe(false);
      expect(cfg.driver).toBe('hana-client');
      expect(cfg.timeoutSeconds).toBe(600); // capped
    });

    it('maps the one-knob tls option', () => {
      const cfg = (tls: string) =>
        engine.buildHanaConfig({ baseUrl: `hana://h.example.test:30015/?tls=${tls}` }).connect;
      expect(cfg('verify')).toMatchObject({ encrypt: true, validateCertificate: true });
      expect(cfg('no-verify')).toMatchObject({ encrypt: true, validateCertificate: false });
      expect(cfg('off')).toMatchObject({ encrypt: false, validateCertificate: false });
      expect(() => cfg('maybe')).toThrow(/tls must be/);
    });

    it('defaults to the bundled driver unless HANA_DRIVER says otherwise', () => {
      process.env.HANA_DRIVER = 'hana-client';
      expect(
        engine.buildHanaConfig({ baseUrl: 'hana://h.example.test:30015' }).driver,
      ).toBe('hana-client');
    });

    it('rejects a client that is not three digits', () => {
      expect(() =>
        engine.buildHanaConfig({ baseUrl: "hana://h.example.test:30015/?sapClient=1'; DROP" }),
      ).toThrow(/three-digit SAP client/);
    });

    it('rejects an unknown driver name', () => {
      expect(() =>
        engine.buildHanaConfig({ baseUrl: 'hana://h.example.test:30015/?driver=odbc' }),
      ).toThrow(/Unknown SAP HANA driver/);
    });
  });

  describe('execute', () => {
    const config = {
      baseUrl: 'hana://h.example.test:30015/?currentSchema=SAPHANADB&sapClient=100',
      authType: 'CONNECTION_STRING',
      authConfig: { username: 'R', password: 'P' },
    };

    it('sets up a read-only session, schema and CDS client before the statement', async () => {
      const session = fakeSession({ rows: [{ BUKRS: '1000' }] });
      openSpy.mockResolvedValue(session);

      const out = await engine.execute(
        config,
        { method: 'query', path: 'SELECT BUKRS FROM T001 WHERE MANDT = ${client} AND BUKRS = ${cc}' },
        { client: '100', cc: '1000' },
      );

      expect(session.calls).toEqual([
        'SET TRANSACTION READ ONLY',
        'SET SCHEMA "SAPHANADB"',
        "SET 'CDS_CLIENT' = '100'",
        'SELECT BUKRS FROM T001 WHERE MANDT = ? AND BUKRS = ?',
      ]);
      expect(session.query).toHaveBeenCalledWith(expect.any(String), ['100', '1000'], 1000);
      expect(session.close).toHaveBeenCalled();
      expect(out).toEqual({ rows: [{ BUKRS: '1000' }], totalRows: 1 });
    });

    it('skips SET TRANSACTION READ ONLY for a read-write connector', async () => {
      const session = fakeSession({ rows: [], rowsAffected: 3 });
      openSpy.mockResolvedValue(session);
      const out = await engine.execute(
        { ...config, baseUrl: 'hana://h.example.test:30015' },
        { method: 'query', path: '${query}' },
        { query: 'UPDATE ZT SET A = 1' },
        { readOnly: false },
      );
      expect(session.calls).toEqual(['UPDATE ZT SET A = 1']);
      expect(out).toEqual({ rowsAffected: 3 });
    });

    it('reports truncation when the driver stopped at the row cap', async () => {
      openSpy.mockResolvedValue(fakeSession({ rows: [{ A: 1 }], truncated: true }));
      const out: any = await engine.execute(
        config,
        { method: 'query', path: '${query}' },
        { query: 'SELECT * FROM ACDOCA' },
      );
      expect(out.truncated).toBe(true);
      expect(out.message).toMatch(/truncated to 1000/);
    });

    it('cancels a statement that runs past the timeout and closes the session', async () => {
      jest.useFakeTimers();
      try {
        const session = fakeSession();
        session.query.mockImplementation(() => new Promise(() => undefined));
        openSpy.mockResolvedValue(session);
        const pending = engine.execute(
          { ...config, baseUrl: 'hana://h.example.test:30015/?statementTimeout=2' },
          { method: 'query', path: '${query}' },
          { query: 'SELECT * FROM ACDOCA' },
        );
        const assertion = expect(pending).rejects.toThrow(/exceeded 2s/);
        await jest.advanceTimersByTimeAsync(2100);
        await assertion;
        expect(session.close).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('rejects writes and locking reads before opening a session', async () => {
      for (const query of [
        'UPSERT T VALUES (1)',
        'SELECT * FROM VBAK FOR UPDATE',
        'SELECT * INTO ZCOPY FROM VBAK',
      ]) {
        await expect(
          engine.execute(config, { method: 'query', path: '${query}' }, { query }),
        ).rejects.toThrow();
      }
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('does not mistake FOR XML / FOR JSON for a locking read', async () => {
      openSpy.mockResolvedValue(fakeSession());
      await expect(
        engine.execute(
          config,
          { method: 'query', path: '${query}' },
          { query: 'SELECT 1 FROM DUMMY FOR JSON' },
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('denied tables', () => {
    const config = { baseUrl: 'hana://h.example.test:30015', authType: 'NONE' };
    const denied = ['PA####', 'USR##', 'RFCDES'];

    it.each([
      'SELECT * FROM PA0008',
      'SELECT * FROM "SAPHANADB"."PA0008"',
      'SELECT a.X FROM ACDOCA a, pa0008 p WHERE 1=1',
      'SELECT * FROM (SELECT BNAME FROM USR02) x',
      'SELECT * FROM RFCDES',
    ])('blocks %s', async (query) => {
      await expect(
        engine.execute(config, { method: 'query', path: '${query}' }, { query }, {
          deniedTables: denied,
        }),
      ).rejects.toThrow(/denied-tables list/);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('allows columns and literals that only look similar', async () => {
      openSpy.mockResolvedValue(fakeSession());
      await expect(
        engine.execute(
          config,
          { method: 'query', path: '${query}' },
          { query: "SELECT PARVW, 'PA0008' AS NOTE FROM VBPA -- PA0008\n" },
          { deniedTables: denied },
        ),
      ).resolves.toBeDefined();
    });

    it('applies to templated tools as well', async () => {
      await expect(
        engine.execute(
          config,
          { method: 'query', path: 'SELECT * FROM PA0001 WHERE PERNR = ${p}' },
          { p: '1' },
          { deniedTables: denied },
        ),
      ).rejects.toThrow(/PA0001/);
    });
  });

  describe('normalizeDeniedTables', () => {
    it('compiles globs and accepts a comma/space separated string', () => {
      const res = normalizeDeniedTables('PA####, HRP*  USR?2');
      expect(res.map((r) => r.test('PA0008'))).toEqual([true, false, false]);
      expect(res[1].test('HRP1000')).toBe(true);
      expect(res[2].test('usr02')).toBe(true);
      expect(res[0].test('PARVW')).toBe(false);
    });

    it('ignores junk', () => {
      expect(normalizeDeniedTables([null, 3, '', '  '])).toEqual([]);
      expect(normalizeDeniedTables(undefined)).toEqual([]);
    });
  });
});

describe('hana.driver', () => {
  it('turns RAW buffers into upper-case hex and keeps decimals as strings', () => {
    expect(hanaDriver.normalizeHanaValue(Buffer.from([0xab, 0x01]))).toBe('AB01');
    expect(hanaDriver.normalizeHanaValue('1234.50')).toBe('1234.50');
    expect(hanaDriver.normalizeHanaValue(BigInt('9007199254740993'))).toBe('9007199254740993');
    expect(hanaDriver.normalizeHanaValue(BigInt(42))).toBe(42);
  });

  it('explains how to install @sap/hana-client when it is missing', () => {
    const prev = process.env.HANA_CLIENT_PATH;
    process.env.HANA_CLIENT_PATH = '/nonexistent/amcp-hana-client';
    try {
      expect(() => hanaDriver.loadHanaClient()).toThrow(hanaDriver.HanaClientMissingError);
      expect(() => hanaDriver.loadHanaClient()).toThrow(/docs\/connectors\/sap-hana\.md/);
    } finally {
      if (prev === undefined) delete process.env.HANA_CLIENT_PATH;
      else process.env.HANA_CLIENT_PATH = prev;
    }
  });

  describe('hdb session', () => {
    const hdb = require('hdb');
    let createClientSpy: jest.SpyInstance;

    afterEach(() => createClientSpy?.mockRestore());

    function mockClient(rowCount: number) {
      const rs = {
        closed: false,
        close: jest.fn((cb: () => void) => {
          rs.closed = true;
          cb();
        }),
        createObjectStream: () =>
          (async function* () {
            for (let i = 0; i < rowCount; i++) yield { N: i, G: Buffer.from([i]) };
          })(),
      };
      const stmt = {
        execute: jest.fn((_values: unknown[], cb: (e: null, r: unknown) => void) => cb(null, rs)),
        drop: jest.fn((cb: () => void) => cb()),
      };
      const client = {
        on: jest.fn(),
        connect: jest.fn((cb: (e: null) => void) => cb(null)),
        exec: jest.fn((_sql: string, cb: (e: null) => void) => cb(null)),
        prepare: jest.fn((_sql: string, cb: (e: null, s: unknown) => void) => cb(null, stmt)),
        end: jest.fn(),
      };
      createClientSpy = jest.spyOn(hdb, 'createClient').mockReturnValue(client);
      return { client, stmt, rs };
    }

    it('streams rows, stops one past the cap and closes everything', async () => {
      const { client, stmt, rs } = mockClient(5);
      const session = await hanaDriver.openHanaSession('hdb', {
        host: 'h',
        port: 30015,
        user: 'u',
        password: 'p',
        encrypt: true,
        validateCertificate: false,
      });
      const out = await session.query('SELECT N FROM T WHERE X = ?', ['a'], 3);
      await session.close();

      expect(createClientSpy).toHaveBeenCalledWith(
        expect.objectContaining({ useTLS: true, rejectUnauthorized: false }),
      );
      expect(stmt.execute).toHaveBeenCalledWith(['a'], expect.any(Function));
      expect(out.truncated).toBe(true);
      expect(out.rows).toEqual([
        { N: 0, G: '00' },
        { N: 1, G: '01' },
        { N: 2, G: '02' },
      ]);
      expect(rs.close).toHaveBeenCalled();
      expect(stmt.drop).toHaveBeenCalled();
      expect(client.end).toHaveBeenCalled();
    });

    it('returns the affected-row count for a statement without a result set', async () => {
      const { stmt } = mockClient(0);
      stmt.execute.mockImplementation((_v: unknown[], cb: (e: null, r: number) => void) => cb(null, 7));
      const session = await hanaDriver.openHanaSession('hdb', {
        host: 'h',
        port: 30015,
        encrypt: false,
        validateCertificate: true,
      });
      expect(await session.query('UPDATE T SET A = 1', [], 10)).toEqual({
        rows: [],
        truncated: false,
        rowsAffected: 7,
      });
    });
  });
});
