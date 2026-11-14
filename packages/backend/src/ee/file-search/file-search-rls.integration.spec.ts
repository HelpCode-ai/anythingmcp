// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
/**
 * File Search without superuser or BYPASSRLS (#1418), against a real,
 * migrated Postgres. The worker's maintenance (scheduler leases, scans,
 * interrupted runs, sweeps), share links and folder rules are exercised as:
 *
 *   - the superuser that ran the migrations (Cloud, default Docker setup);
 *   - a LOGIN role NOSUPERUSER NOBYPASSRLS that owns nothing, member of amcp_files;
 *   - the same kind of role without amcp_files (a managed database where the
 *     migration could not create the role): the policies bind the user itself.
 *
 * Runs where CI runs the other Postgres specs: AUDIT_TEST_DATABASE_URL (or
 * FILES_RLS_TEST_DATABASE_URL) must point at a migrated test database and
 * connect as a superuser, which creates and drops its own roles and rows.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { Pool, PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { FileSearchRepository, type FileDbMode } from '../../file-search/file-search.repository';
import { FileShareService } from '../../file-search/file-share.service';
import { FileSearchEngine } from '../../file-search/file-search.engine';
import { FilesWorkerService } from './files-worker.service';
import { Scheduler } from './sync/scheduler';

const url = process.env.FILES_RLS_TEST_DATABASE_URL || process.env.AUDIT_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const rand = () => randomBytes(4).toString('hex');

type Variant = { name: string; kind: 'superuser' | 'amcp_files' | 'plain'; expectMode: FileDbMode };
const VARIANTS: Variant[] = [
  { name: 'superuser (Cloud, default Docker)', kind: 'superuser', expectMode: 'amcp_files' },
  { name: 'app user NOSUPERUSER NOBYPASSRLS, member of amcp_files', kind: 'amcp_files', expectMode: 'amcp_files' },
  { name: 'app user NOSUPERUSER NOBYPASSRLS, without amcp_files', kind: 'plain', expectMode: 'rls' },
];

d('File Search maintenance under Row-Level Security (real Postgres, #1418)', () => {
  let admin: Pool;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ||= 'files-rls-integration-key-0123456789';
    admin = new Pool({ connectionString: url, max: 2 });
    const [{ su }] = (await admin.query('SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user')).rows;
    if (!su) throw new Error('the File Search RLS integration spec needs a superuser connection');
    const policy = await admin.query("SELECT polcmd FROM pg_policy WHERE polname = 'share_by_token' AND polrelid = 'file_shares'::regclass");
    // 'r' = SELECT only: the policy can never let a write through.
    expect(policy.rows).toEqual([{ polcmd: 'r' }]);
  });

  afterAll(async () => {
    await admin?.end();
  });

  for (const v of VARIANTS) {
    describe(v.name, () => {
      const p = `fsrls-${v.kind}-${rand()}`;
      const A = `${p}-org-a`;
      const B = `${p}-org-b`;
      const user = `${p}-user`;
      const role = `${p}-role`;
      const dbRole = `fsrls_${v.kind}_${rand()}`;
      const token = randomBytes(24).toString('base64url');
      let prisma: any;
      let pool: Pool;
      let repo: FileSearchRepository;
      const deleted: string[] = [];
      const shares = () => {
        const svc = new FileShareService(prisma, repo, {} as any, {} as any);
        (svc as any).storageInstance = {
          kind: 'local',
          put: async () => undefined,
          open: async () => ({ stream: Readable.from([Buffer.from('hello')]) }),
          delete: async (k: string) => void deleted.push(k),
        };
        return svc;
      };
      const pending: Array<() => void> = [];
      const hang = () => new Promise<any>((resolve) => pending.push(() => resolve({ status: 'skipped' })));
      const scheduler = (worker: string) =>
        new Scheduler(prisma, repo, { run: jest.fn(hang) } as any, { run: jest.fn(hang), redescribe: jest.fn(hang) } as any, shares(), worker, 3) as any;
      const src = async (connectorId: string) =>
        (await admin.query('SELECT lease_owner, lease_until FROM file_sources WHERE connector_id = $1', [connectorId])).rows[0];

      /** A raw transaction as the tested user, switched to amcp_files when that is how the repository works. */
      async function asTested<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          if (v.expectMode === 'amcp_files') await c.query('SET LOCAL ROLE amcp_files');
          return await fn(c);
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
      }

      beforeAll(async () => {
        let testedUrl = url!;
        if (v.kind !== 'superuser') {
          const password = randomBytes(12).toString('hex');
          await admin.query(`CREATE ROLE ${dbRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'`);
          // The grants of an application user on a managed database; it owns nothing.
          await admin.query(`GRANT USAGE ON SCHEMA public TO ${dbRole}`);
          await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${dbRole}`);
          await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${dbRole}`);
          if (v.kind === 'amcp_files') await admin.query(`GRANT amcp_files TO ${dbRole}`);
          const u = new URL(url!);
          u.username = dbRole;
          u.password = password;
          testedUrl = u.toString();
        }
        prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testedUrl }) });
        pool = new Pool({ connectionString: testedUrl, max: 2 });
        repo = new FileSearchRepository(prisma);

        // Seed as the superuser (bypasses RLS).
        const q = (sql: string, args: unknown[] = []) => admin.query(sql, args);
        await q('INSERT INTO organizations (id, name, updated_at) VALUES ($1, $2, now()), ($3, $4, now())', [A, 'Workspace A', B, 'Workspace B']);
        await q('INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())', [user, `${p}@example.test`]);
        await q("INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'EDITOR')", [`${p}-m`, A, user]);
        for (const [id, org, active] of [['a1', A, true], ['a2', A, true], ['adraft', A, false], ['b1', B, true]] as const) {
          await q(
            "INSERT INTO connectors (id, user_id, organization_id, name, type, base_url, is_active, updated_at) VALUES ($1, $2, $3, $4, 'FILE_SEARCH', 'files://', $5, now())",
            [`${p}-${id}`, user, org, id, active],
          );
        }
        const source = (id: string, org: string, state: string, nextMin: number | null, createdDaysAgo = 0) =>
          q(
            `INSERT INTO file_sources (connector_id, organization_id, setup_state, next_sync_at, created_at, updated_at)
             VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(mins => $4::int) END, now() - make_interval(days => $5::int), now())`,
            [`${p}-${id}`, org, state, nextMin, createdDaysAgo],
          );
        await source('a1', A, 'active', 10);
        await source('a2', A, 'active', 5);
        await source('adraft', A, 'draft', null, 8);
        await source('b1', B, 'active', 20);
        await q("INSERT INTO file_scans (id, organization_id, connector_id, status, created_at) VALUES ($1, $2, $3, 'queued', now() - interval '2 minutes'), ($4, $5, $6, 'queued', now() - interval '3 minutes'), ($7, $2, $3, 'running', now() - interval '20 minutes')", [
          `${p}-scan-a`, A, `${p}-a1`, `${p}-scan-b`, B, `${p}-b1`, `${p}-scan-stale`,
        ]);
        await q("INSERT INTO file_sync_runs (id, organization_id, connector_id, trigger, status) VALUES ($1, $2, $3, 'schedule', 'running'), ($4, $5, $6, 'schedule', 'running')", [
          `${p}-run-a2`, A, `${p}-a2`, `${p}-run-b1`, B, `${p}-b1`,
        ]);
        const share = (id: string, org: string, hash: string, extra: string) =>
          q(
            `INSERT INTO file_shares (id, organization_id, source, storage_key, filename, mime_type, bytes, sha256, access, token_hash, expires_at, revoked_at)
             VALUES ($1, $2, 'upload', $3, $4, 'text/plain', 5, 'x', 'public', $5, ${extra})`,
            [id, org, `key-${id}`, `${id}.txt`, hash],
          );
        await share('a'.repeat(23) + '1', A, sha256(`${p}-expired`), "now() - interval '1 hour', NULL");
        await share('b'.repeat(23) + '1', B, sha256(`${p}-revoked`), "now() + interval '1 hour', now()");
        await share('b'.repeat(23) + '2', B, sha256(token), "now() + interval '1 hour', NULL");
        // A row whose hash is the empty string: an emptied setting must still match nothing.
        await share('b'.repeat(23) + '3', B, '', "now() + interval '1 hour', NULL");
        await q('INSERT INTO roles (id, name, organization_id, updated_at) VALUES ($1, $2, $3, now())', [role, `Sales ${p}`, A]);
        await q('INSERT INTO user_roles (id, user_id, role_id, organization_id) VALUES ($1, $2, $3, $4)', [`${p}-ur`, user, role, A]);
        await q("INSERT INTO file_access_rules (id, organization_id, connector_id, role_id, pattern, effect) VALUES ($1, $2, $3, $4, 'Intern', 'deny')", [
          `${p}-rule`, A, `${p}-a1`, role,
        ]);
      }, 60_000);

      afterAll(async () => {
        pending.splice(0).forEach((f) => f());
        await prisma?.$disconnect();
        await pool?.end();
        await admin.query('DELETE FROM organizations WHERE id = ANY($1)', [[A, B]]);
        await admin.query('DELETE FROM users WHERE id = $1', [user]);
        if (v.kind !== 'superuser') {
          await admin.query(`DROP OWNED BY ${dbRole}`);
          await admin.query(`DROP ROLE IF EXISTS ${dbRole}`);
        }
      }, 60_000);

      it('runs in the expected mode and sees its sources', async () => {
        const vis = await repo.visibility();
        expect(vis.mode).toBe(v.expectMode);
        expect(vis.visibleSources).toBe(vis.connectors);
        expect(vis.connectors).toBeGreaterThanOrEqual(4);
      });

      it('claims the most overdue source per workspace, renews and releases inside the workspace', async () => {
        const s = scheduler(`${p}-w1`);
        s.lastSweep = Date.now();
        await s.tick();
        const runs = (s.sync.run as jest.Mock).mock.calls.map((c) => c[0]);
        expect(runs.filter((id: string) => id.startsWith(p))).toEqual([`${p}-b1`, `${p}-a1`]);
        expect((await src(`${p}-b1`)).lease_owner).toBe(`${p}-w1`);
        expect((await src(`${p}-a1`)).lease_owner).toBe(`${p}-w1`);
        expect((await src(`${p}-a2`)).lease_owner).toBeNull();
        // Scans: both queued scans claimed, the stale one failed.
        const scans = (await admin.query('SELECT id, status FROM file_scans WHERE organization_id = ANY($1) ORDER BY id', [[A, B]])).rows;
        expect(Object.fromEntries(scans.map((r) => [r.id.slice(p.length + 1), r.status]))).toEqual({ 'scan-a': 'running', 'scan-b': 'running', 'scan-stale': 'failed' });
        // A second worker finds every workspace busy.
        const w2 = scheduler(`${p}-w2`);
        w2.lastSweep = Date.now();
        await w2.tick();
        expect((w2.sync.run as jest.Mock).mock.calls.filter((c) => String(c[0]).startsWith(p))).toEqual([]);
        // Renewal inside the wrong workspace touches nothing; in its own it does.
        expect(await s.renew(`${p}-b1`, A)).toBe(0);
        expect(await s.renew(`${p}-a1`, A)).toBe(1);
        // Interrupted runs: a2 has no lease (closed), b1 has one (kept).
        await new FilesWorkerService(prisma, repo, {} as any, {} as any).closeInterruptedRuns();
        const runRows = (await admin.query('SELECT id, status FROM file_sync_runs WHERE organization_id = ANY($1) ORDER BY id', [[A, B]])).rows;
        expect(runRows.map((r) => r.status)).toEqual(['partial', 'running']);
        // Finished slices release their leases.
        pending.splice(0).forEach((f) => f());
        await Promise.all([...s.running.values()]);
        expect((await src(`${p}-a1`)).lease_owner).toBeNull();
        expect((await src(`${p}-b1`)).lease_owner).toBeNull();
        // stop() releases the leases this worker holds, per workspace.
        const claimed = await s.claimDue([await s.survey(A, true), await s.survey(B, true)], 3);
        expect(claimed).toEqual([
          { connectorId: `${p}-b1`, organizationId: B },
          { connectorId: `${p}-a1`, organizationId: A },
        ]);
        await s.stop();
        expect((await src(`${p}-a1`)).lease_until).toBeNull();
        expect((await src(`${p}-b1`)).lease_until).toBeNull();
      }, 60_000);

      it('sweeps drafts and expired or revoked shares one workspace at a time', async () => {
        const s = scheduler(`${p}-w3`);
        await s.sweep([A, B]);
        const left = (await admin.query('SELECT id FROM connectors WHERE organization_id = ANY($1) ORDER BY id', [[A, B]])).rows.map((r) => r.id);
        expect(left).toEqual([`${p}-a1`, `${p}-a2`, `${p}-b1`]);
        const purged = (await admin.query('SELECT filename, purged_at IS NOT NULL AS purged FROM file_shares WHERE organization_id = ANY($1) ORDER BY filename', [[A, B]])).rows;
        expect(purged.filter((r) => r.purged).length).toBe(2);
        expect(purged.find((r) => r.filename === 'b'.repeat(23) + '2.txt')?.purged).toBe(false);
        expect(deleted).toHaveLength(2);
      }, 60_000);

      it('opens a share link by its token and a signed download inside its workspace', async () => {
        const svc = shares();
        expect(await svc.describe(token)).toMatchObject({ filename: 'b'.repeat(23) + '2.txt', workspace: 'Workspace B', state: 'active' });
        const { url: dl } = await svc.issueDownload(token, null);
        const signed = dl.split('/d/')[1];
        expect(signed.split('.')[1]).toBe(B);
        expect((await svc.openSigned(signed)).filename).toBe('b'.repeat(23) + '2.txt');
        const [{ n }] = (await admin.query('SELECT download_count AS n FROM file_shares WHERE token_hash = $1', [sha256(token)])).rows;
        expect(n).toBe(1);
        await expect(svc.describe(randomBytes(24).toString('base64url'))).rejects.toThrow(/does not exist/);
        const [id, , exp, sig] = signed.split('.');
        await expect(svc.openSigned(`${id}.${A}.${exp}.${sig}`)).rejects.toThrow(/Invalid/);
      }, 60_000);

      it('honours a folder deny rule', async () => {
        const access: any = { resolve: async () => ({ allowed: true, quota: { folderRules: true } }) };
        const engine = new FileSearchEngine(prisma, {} as any, access, {} as any, {} as any, repo);
        const scope = await engine.scopeFor({ organizationId: A, connectorId: `${p}-a1`, userId: user });
        expect(scope).toEqual({ organizationId: A, connectorId: `${p}-a1`, deny: ['Intern'] });
      }, 60_000);

      it('isolates the workspaces and reveals a share only to its token', async () => {
        // Workspace A's transaction neither reads nor changes workspace B.
        const seen = await repo.withTenant(A, (tx) => tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM file_sources WHERE organization_id = ${B}`);
        expect(seen[0].n).toBe(0);
        expect(await repo.withTenant(A, (tx) => tx.$executeRaw`UPDATE file_sources SET summary = 'x' WHERE organization_id = ${B}`)).toBe(0);
        expect(await repo.withTenant(A, (tx) => tx.$executeRaw`UPDATE file_sync_runs SET error = 'x'`)).toBe(1);
        // A wrong hash shows nothing; the right one exactly its row, read-only.
        expect(await repo.withShareToken(sha256('wrong-token'), (tx) => tx.fileShare.findMany())).toEqual([]);
        const rows = await repo.withShareToken(sha256(token), (tx) => tx.fileShare.findMany());
        expect(rows.map((r) => r.organizationId)).toEqual([B]);
        expect(await repo.withShareToken(sha256(token), (tx) => tx.$executeRaw`UPDATE file_shares SET download_count = 99`)).toBe(0);
        expect(await repo.withShareToken(sha256(token), (tx) => tx.$executeRaw`DELETE FROM file_shares`)).toBe(0);
        expect(await repo.withShareToken(sha256(token), (tx) => tx.fileSource.count())).toBe(0);
        const [{ n: count }] = (await admin.query('SELECT download_count AS n FROM file_shares WHERE token_hash = $1', [sha256(token)])).rows;
        expect(count).toBe(1);
        // Unset, emptied or session-reset settings reveal nothing (the '' row included).
        await asTested(async (c) => {
          expect((await c.query('SELECT count(*)::int AS n FROM file_shares')).rows[0].n).toBe(0);
          expect((await c.query('SELECT count(*)::int AS n FROM file_sources')).rows[0].n).toBe(0);
          await c.query("SELECT set_config('app.share_token_hash', '', true)");
          expect((await c.query('SELECT count(*)::int AS n FROM file_shares')).rows[0].n).toBe(0);
          await c.query("SELECT set_config('app.current_org', '', true)");
          expect((await c.query('SELECT count(*)::int AS n FROM file_access_rules')).rows[0].n).toBe(0);
        });
        if (v.kind !== 'superuser') {
          // Outside any transaction the user itself is bound by the policies.
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            await c.query("SELECT set_config('app.share_token_hash', $1, true)", [sha256(token)]);
            await c.query('COMMIT');
            // After the transaction the setting is '' (not NULL) on this session.
            expect((await c.query("SELECT current_setting('app.share_token_hash', true) AS s")).rows[0].s).toBe('');
            expect((await c.query('SELECT count(*)::int AS n FROM file_shares')).rows[0].n).toBe(0);
            await expect(c.query("UPDATE file_sources SET summary = 'x'")).resolves.toMatchObject({ rowCount: 0 });
          } finally {
            c.release();
          }
        }
      }, 60_000);
    });
  }
});
