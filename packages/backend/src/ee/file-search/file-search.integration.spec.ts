// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
/**
 * Live checks against real servers (#1382): SFTP, FTPS and WebDAV test
 * containers, and Row-Level Security on the file_* tables in a real Postgres.
 *
 *   RUN_FILES_INTEGRATION=1
 *   FILES_IT_SFTP=host:port:user:pass:/root   (e.g. atmoz/sftp)
 *   FILES_IT_FTPS=host:port:user:pass:/root   (pure-ftpd with TLS)
 *   FILES_IT_WEBDAV=url|user|pass|/root       (bytemark/webdav)
 *   FILES_IT_DATABASE_URL=postgresql://…      (migrated database)
 */
import { Pool } from 'pg';
import { driverFor } from './sources';
import { parseFileSearchConfig } from '../../file-search/file-search-config';

const on = process.env.RUN_FILES_INTEGRATION === '1';
const d = on ? describe : describe.skip;

async function listAndRead(config: any, secrets: any) {
  let first: any;
  try {
    first = await driverFor(config.protocol).connect(config, secrets, { cloud: false, test: true });
  } catch (err: any) {
    // FTPS with a self-signed certificate: the test reports the fingerprint instead of logging in.
    if (err?.kind !== 'fingerprint_unconfirmed' || !err.fingerprint) throw err;
    first = { fingerprint: err.fingerprint, session: { close: async () => undefined } };
  }
  if (first.fingerprint && !config.hostKeySha256 && !config.tlsFingerprintSha256) {
    await first.session.close();
  }
  const pinned = first.fingerprint
    ? { ...config, [first.fingerprint.kind === 'ssh-host-key' ? 'hostKeySha256' : 'tlsFingerprintSha256']: first.fingerprint.sha256 }
    : config;
  const { session } = first.fingerprint ? await driverFor(config.protocol).connect(pinned, secrets, { cloud: false }) : first;
  try {
    const root = await session.list('');
    const dir = root.find((e: any) => e.isDir)!;
    const files = await session.list(dir.path);
    const sub = files.find((e: any) => e.isDir)!;
    const inner = await session.list(sub.path);
    const file = inner.find((e: any) => !e.isDir)!;
    const chunks: Buffer[] = [];
    for await (const c of await session.open(file.path, 50 * 1024 * 1024)) chunks.push(c as Buffer);
    // FTP runs one command at a time: a second download after the first must work too.
    const second = inner.filter((e: any) => !e.isDir)[1];
    if (second) for await (const _ of await session.open(second.path, 50 * 1024 * 1024)) void _;
    return { rootCount: root.length, bytes: Buffer.concat(chunks).length, size: file.size };
  } finally {
    await session.close();
  }
}

d('File Search drivers against test servers', () => {
  beforeAll(() => {
    process.env.SSRF_ALLOW_LOCALHOST = 'true';
  });
  const cases: Array<[string, string | undefined, (v: string) => [any, any]]> = [
    ['sftp', process.env.FILES_IT_SFTP, (v) => { const [host, port, username, password, rootPath] = v.split(':'); return [{ protocol: 'sftp', host, port: Number(port), username, rootPath }, { password }]; }],
    ['ftps', process.env.FILES_IT_FTPS, (v) => { const [host, port, username, password, rootPath] = v.split(':'); return [{ protocol: 'ftps', host, port: Number(port), username, rootPath }, { password }]; }],
    ['webdav', process.env.FILES_IT_WEBDAV, (v) => { const [url, username, password, rootPath] = v.split('|'); return [{ protocol: 'webdav', url, username, rootPath }, { password }]; }],
  ];
  for (const [name, env, parse] of cases) {
    (env ? it : it.skip)(`${name}: lists folders and downloads a file`, async () => {
      const [raw, secrets] = parse(env!);
      const config = parseFileSearchConfig(raw, { cloud: false });
      const r = await listAndRead(config, secrets);
      expect(r.rootCount).toBeGreaterThan(0);
      expect(r.bytes).toBe(r.size);
    }, 60_000);
  }
  (process.env.FILES_IT_SFTP ? it : it.skip)('sftp: a wrong pinned host key is refused before login', async () => {
    const [host, port, username, password, rootPath] = process.env.FILES_IT_SFTP!.split(':');
    const config = parseFileSearchConfig({ protocol: 'sftp', host, port: Number(port), username, rootPath, hostKeySha256: 'SHA256:wrong' }, { cloud: false });
    await expect(driverFor('sftp').connect(config, { password }, { cloud: false })).rejects.toMatchObject({ kind: 'fingerprint_mismatch' });
  }, 30_000);
});

d('Row-Level Security on file_* tables', () => {
  const url = process.env.FILES_IT_DATABASE_URL;
  (url ? it : it.skip)('amcp_files sees only the current organization', async () => {
    const pool = new Pool({ connectionString: url });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const orgs = await c.query('SELECT id FROM organizations LIMIT 1');
      const org = orgs.rows[0]?.id ?? 'none';
      const all = await c.query('SELECT count(*)::int n FROM file_entries');
      await c.query("SELECT set_config('app.current_org', $1, true)", ['org-that-does-not-exist']);
      await c.query('SET LOCAL ROLE amcp_files');
      const other = await c.query('SELECT count(*)::int n FROM file_entries');
      expect(other.rows[0].n).toBe(0);
      await c.query('RESET ROLE');
      await c.query("SELECT set_config('app.current_org', $1, true)", [org]);
      await c.query('SET LOCAL ROLE amcp_files');
      const mine = await c.query('SELECT count(*)::int n FROM file_entries');
      expect(mine.rows[0].n).toBeLessThanOrEqual(all.rows[0].n);
      await expect(c.query("INSERT INTO file_sources (connector_id, organization_id, setup_state, stats, updated_at) VALUES ('x', 'another-org', 'draft', '{}', now())")).rejects.toThrow(/row-level security/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
      await pool.end();
    }
  });
});
