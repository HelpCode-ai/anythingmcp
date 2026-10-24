import { DatabaseEngine } from './database.engine';
import { SsrfBlockedError } from '../../common/ssrf.util';

/**
 * The DB connection string is user-supplied, so the engine must apply the same
 * SSRF policy as the HTTP engines before any driver opens a socket. The guard is
 * disabled by default under jest, so these tests opt in with SSRF_GUARD=enabled.
 */
describe('DatabaseEngine — SSRF guard', () => {
  const engine = new DatabaseEngine();
  const query = { method: 'query', path: '${q}' };
  const params = { q: 'SELECT 1' };

  beforeEach(() => {
    process.env.SSRF_GUARD = 'enabled';
  });
  afterEach(() => {
    delete process.env.SSRF_GUARD;
    delete process.env.SSRF_ALLOW_PRIVATE;
    delete process.env.SSRF_ALLOWED_HOSTS;
    delete process.env.DEPLOYMENT_MODE;
  });

  const cfg = (baseUrl: string) => ({ baseUrl, authType: 'none' });

  it('blocks the cloud metadata IP', async () => {
    await expect(
      engine.execute(cfg('postgres://u:p@169.254.169.254:5432/db'), query, params),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks loopback by hostname (localhost)', async () => {
    await expect(
      engine.execute(cfg('mongodb://localhost:27017/db'), { method: 'query', path: '${q}' }, { q: '{}' }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks a private RFC1918 host', async () => {
    await expect(
      engine.execute(cfg('mysql://10.0.0.5:3306/db'), query, params),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks via testConnection too', async () => {
    await expect(engine.testConnection(cfg('postgres://127.0.0.1/db'))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('parses credentials + replica-set hosts and blocks a private member', async () => {
    // First host is a public literal IP (no DNS); second is private → must block,
    // which proves both credential stripping and comma-separated host parsing.
    await expect(
      engine.execute(
        cfg('mongodb://user:p%40ss@8.8.8.8:27017,10.0.0.1:27017/db'),
        { method: 'query', path: '${q}' },
        { q: '{}' },
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows a blocked host when explicitly allowlisted', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'db.internal';
    // Passes the SSRF guard (allowlisted) → fails later on the actual connection,
    // never with SsrfBlockedError.
    await expect(
      engine.execute(cfg('postgres://u:p@db.internal:5432/db'), query, params),
    ).rejects.not.toBeInstanceOf(SsrfBlockedError);
  });

  it('skips the guard for sqlite (local file, no network host)', async () => {
    // No SsrfBlockedError for a sqlite path; it fails opening the file instead.
    await expect(
      engine.execute(cfg('sqlite:///nonexistent-amcp-test.db'), query, params),
    ).rejects.not.toBeInstanceOf(SsrfBlockedError);
  });

  it('refuses sqlite on the cloud, where the file system is shared by every workspace', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    await expect(
      engine.execute(cfg('sqlite:///app/backend/data.db'), query, params),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(engine.testConnection(cfg('sqlite:/tmp/x.db'))).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});
