import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { DatabaseEngine } from './database.engine';

const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery, end: jest.fn() })),
}));

const mockToArray = jest.fn();
jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    close: jest.fn(),
    db: () => ({
      command: jest.fn(),
      collection: () => ({ find: () => ({ limit: () => ({ toArray: mockToArray }) }) }),
    }),
  })),
}));

/**
 * On AnythingMCP Cloud the server's disk is shared by every workspace, so the
 * connection-string parameters that make a driver read a server file (and
 * pg's `options`) are removed before the driver sees the string. Self-hosted
 * instances pass them through unchanged.
 */
describe('DatabaseEngine — connection parameters on Cloud', () => {
  const engine = new DatabaseEngine();
  const query = { method: 'query', path: '${q}' };
  const pgUrl =
    'postgres://u:p@db.example.com:5432/app?sslmode=require&sslrootcert=/etc/ca.pem&sslcert=/c&sslkey=/k&options=-c%20a%3Db&application_name=x';
  const mongoUrl = 'mongodb://u:p@db.example.com:27017/app?tls=true&tlsCAFile=/etc/ca.pem&tlsCertificateKeyFile=/k';
  let warn: jest.SpyInstance;

  const pgConnectionString = () =>
    (Pool as unknown as jest.Mock).mock.calls.at(-1)[0].connectionString as string;
  const mongoConnectionString = () => (MongoClient as unknown as jest.Mock).mock.calls.at(-1)[0] as string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ ok: 1 }], rowCount: 1 });
    mockToArray.mockResolvedValue([]);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.DEPLOYMENT_MODE;
    warn.mockRestore();
  });

  describe('cloud', () => {
    beforeEach(() => {
      process.env.DEPLOYMENT_MODE = 'cloud';
    });

    it('removes sslcert, sslkey, sslrootcert and options from a query, keeping sslmode', async () => {
      await engine.execute({ baseUrl: pgUrl, authType: 'NONE' }, query, { q: 'SELECT 1' });
      expect(pgConnectionString()).toBe('postgres://u:p@db.example.com:5432/app?sslmode=require&application_name=x');
    });

    it('does the same for a connection test', async () => {
      await engine.testConnection({ baseUrl: pgUrl, authType: 'NONE' });
      expect(pgConnectionString()).toBe('postgres://u:p@db.example.com:5432/app?sslmode=require&application_name=x');
    });

    it('logs the removed names once per connection, never their values', async () => {
      await engine.execute({ baseUrl: pgUrl, authType: 'NONE' }, query, { q: 'SELECT 1' });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('sslrootcert, sslcert, sslkey, options');
      expect(line).not.toContain('/etc/ca.pem');
      expect(line).not.toContain(':p@');
    });

    it('keeps a normal connection string unchanged and logs nothing', async () => {
      const plain = 'postgres://u:p@db.example.com:5432/app?sslmode=verify-full';
      await engine.execute({ baseUrl: plain, authType: 'NONE' }, query, { q: 'SELECT 1' });
      expect(pgConnectionString()).toBe(plain);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps credentials from authConfig and removes the parameters', async () => {
      await engine.execute(
        { baseUrl: 'postgres://db.example.com/app?sslkey=/k', authType: 'BASIC', authConfig: { username: 'ro', password: 's3cret' } },
        query,
        { q: 'SELECT 1' },
      );
      expect(pgConnectionString()).toBe('postgres://ro:s3cret@db.example.com/app');
    });

    it('removes the MongoDB TLS file options', async () => {
      await engine.execute({ baseUrl: mongoUrl, authType: 'NONE' }, query, { q: '{"collection":"c"}' });
      expect(mongoConnectionString()).toBe('mongodb://u:p@db.example.com:27017/app?tls=true');
      await engine.testConnection({ baseUrl: mongoUrl, authType: 'NONE' });
      expect(mongoConnectionString()).toBe('mongodb://u:p@db.example.com:27017/app?tls=true');
    });
  });

  describe('self-hosted', () => {
    it('passes every parameter through unchanged', async () => {
      await engine.execute({ baseUrl: pgUrl, authType: 'NONE' }, query, { q: 'SELECT 1' });
      expect(pgConnectionString()).toBe(pgUrl);
      await engine.execute({ baseUrl: mongoUrl, authType: 'NONE' }, query, { q: '{"collection":"c"}' });
      expect(mongoConnectionString()).toBe(mongoUrl);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
