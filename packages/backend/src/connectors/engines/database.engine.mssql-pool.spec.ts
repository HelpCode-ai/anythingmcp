import * as mssql from 'mssql';
import { DatabaseEngine } from './database.engine';

// Each ConnectionPool records the config it was built with, answers queries
// with that config's database name, and lets the test decide when a query
// finishes, so two calls can be made to overlap.
interface FakePool {
  config: { server?: string; database?: string };
  closed: boolean;
  release: () => void;
}
const pools: FakePool[] = [];

jest.mock('mssql', () => {
  class ConnectionPool {
    config: { server?: string; database?: string };
    closed = false;
    release: () => void = () => undefined;
    constructor(config: { server?: string; database?: string }) {
      this.config = config;
      pools.push(this);
    }
    async connect() {
      if (this.config.server === 'down.example.test') throw new Error('Failed to connect');
      return this;
    }
    async close() {
      this.closed = true;
    }
    request() {
      return {
        input: jest.fn(),
        query: () =>
          new Promise((resolve, reject) => {
            if (this.closed) return reject(new Error('Connection is closed.'));
            this.release = () =>
              this.closed
                ? reject(new Error('Connection is closed.'))
                : resolve({ recordset: [{ db: this.config.database }], rowsAffected: [1] });
          }),
      };
    }
  }
  return {
    ConnectionPool,
    // The process-wide pool must never be used: it ignores the config while open.
    connect: jest.fn(() => Promise.reject(new Error('mssql.connect() must not be used'))),
    Transaction: jest.fn().mockImplementation(() => ({
      begin: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    })),
    Request: jest.fn(),
  };
});

jest.mock('../../common/ssrf.util', () => ({
  ...jest.requireActual('../../common/ssrf.util'),
  assertSafeOutboundHost: jest.fn().mockResolvedValue(undefined),
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('DatabaseEngine SQL Server pools', () => {
  let engine: DatabaseEngine;

  beforeEach(() => {
    engine = new DatabaseEngine();
    pools.length = 0;
  });

  const run = (baseUrl: string) =>
    engine.execute(
      { baseUrl, authType: 'CONNECTION_STRING' },
      { method: 'query', path: '${query}' },
      { query: 'SELECT DB_NAME() AS db' },
      { readOnly: false },
    );

  it('gives two overlapping calls on different connectors a pool each, with their own config', async () => {
    const first = run('mssql://a.example.test:1433/sales');
    const second = run('mssql://b.example.test:1433/loyalty');
    await flush();

    expect(pools.map((p) => [p.config.server, p.config.database])).toEqual([
      ['a.example.test', 'sales'],
      ['b.example.test', 'loyalty'],
    ]);

    // The first call finishing must not close the second call's connection.
    pools[0].release();
    await expect(first).resolves.toMatchObject({ rows: [{ db: 'sales' }] });
    expect(pools[0].closed).toBe(true);
    expect(pools[1].closed).toBe(false);

    pools[1].release();
    await expect(second).resolves.toMatchObject({ rows: [{ db: 'loyalty' }] });
    expect(pools[1].closed).toBe(true);
    expect(mssql.connect).not.toHaveBeenCalled();
  });

  it('closes the pool when the connection fails', async () => {
    await expect(run('mssql://down.example.test:1433/sales')).rejects.toThrow('Failed to connect');
    expect(pools).toHaveLength(1);
    expect(pools[0].closed).toBe(true);
  });

  it('tests a connection on a pool of its own and closes it', async () => {
    const test = engine.testConnection({
      baseUrl: 'mssql://c.example.test:1433/stock',
      authType: 'CONNECTION_STRING',
    });
    await flush();
    expect(pools).toHaveLength(1);
    expect(pools[0].config.database).toBe('stock');
    pools[0].release();
    await test;
    expect(pools[0].closed).toBe(true);
    expect(mssql.connect).not.toHaveBeenCalled();
  });
});
