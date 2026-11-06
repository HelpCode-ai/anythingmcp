// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { Scheduler } from './scheduler';

/**
 * The scheduler against a fake database that behaves like the file_*
 * policies (#1418): a query sees only the rows of the workspace its
 * withTenant transaction names, and the bare connection sees nothing.
 */

interface Src {
  connectorId: string;
  org: string;
  nextSyncAt: Date;
  state?: string;
  active?: boolean;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
}
interface Scan {
  id: string;
  org: string;
  status: string;
  createdAt: Date;
}

const ago = (min: number) => new Date(Date.now() - min * 60_000);
const ELIGIBLE = new Set(['active', 'syncing', 'paused_quota', 'paused_licence', 'paused_error']);

function fakeDb(sources: Src[], scans: Scan[] = []) {
  const log: Array<{ org: string; sql: string; values: unknown[] }> = [];
  const tenantsCalls = { n: 0 };
  const live = (s: Src) => !!s.leaseUntil && s.leaseUntil.getTime() > Date.now();
  const candidate = (org: string) => {
    const mine = sources.filter((s) => s.org === org);
    if (mine.some(live)) return null;
    return (
      mine
        .filter((s) => s.active !== false && ELIGIBLE.has(s.state ?? 'active') && s.nextSyncAt.getTime() <= Date.now() && !live(s))
        .sort((a, b) => a.nextSyncAt.getTime() - b.nextSyncAt.getTime())[0] ?? null
    );
  };
  const run = (org: string, strings: TemplateStringsArray, values: unknown[]): any => {
    const sql = strings.join('?');
    log.push({ org, sql, values });
    // Every statement must name its workspace, also for a user that bypasses RLS.
    if (/file_(sources|scans)/.test(sql) && !values.includes(org)) throw new Error(`query without organization filter: ${sql}`);
    if (sql.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
    if (sql.includes('SELECT created_at FROM file_scans')) {
      const q = scans.filter((s) => s.org === org && ['queued', 'describing'].includes(s.status)).sort((a, b) => +a.createdAt - +b.createdAt);
      return q[0] ? [{ created_at: q[0].createdAt }] : [];
    }
    if (sql.includes("SET status = 'failed'")) return 0;
    if (sql.includes('SELECT s.connector_id, s.next_sync_at')) {
      const c = candidate(org);
      return c ? [{ connector_id: c.connectorId, next_sync_at: c.nextSyncAt }] : [];
    }
    if (sql.includes('UPDATE file_sources SET lease_owner = ?')) {
      const c = candidate(org);
      if (!c) return [];
      c.leaseOwner = values[0] as string;
      c.leaseUntil = new Date(Date.now() + 10 * 60_000);
      return [{ connector_id: c.connectorId, organization_id: c.org }];
    }
    if (sql.includes('SET lease_until = now()')) {
      const [, connectorId, o, owner] = values;
      const s = sources.find((x) => x.org === org && x.connectorId === connectorId && x.org === o && x.leaseOwner === owner);
      if (s) s.leaseUntil = new Date(Date.now() + 10 * 60_000);
      return s ? 1 : 0;
    }
    if (sql.includes('SET lease_owner = NULL')) {
      const [connectorId, o, owner] = values;
      const s = sources.find((x) => x.org === org && x.connectorId === connectorId && x.org === o && x.leaseOwner === owner);
      if (s) Object.assign(s, { leaseOwner: null, leaseUntil: null });
      return s ? 1 : 0;
    }
    if (sql.includes('UPDATE file_scans SET status = CASE')) {
      const room = values[2] as number;
      const picked = scans.filter((s) => s.org === org && ['queued', 'describing'].includes(s.status)).sort((a, b) => +a.createdAt - +b.createdAt).slice(0, room);
      for (const s of picked) s.status = s.status === 'queued' ? 'running' : 'describing_running';
      return picked.map((s) => ({ id: s.id, organization_id: s.org, status: s.status }));
    }
    if (sql.includes("setup_state = 'draft'") || sql.includes("setup_state = 'paused_licence'")) return [];
    if (sql.includes('SET samples = NULL')) return 0;
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const repo: any = {
    tenantsWithFileSearch: jest.fn(async () => {
      tenantsCalls.n++;
      return [...new Set(sources.map((s) => s.org).concat(scans.map((s) => s.org)))].sort();
    }),
    withTenant: jest.fn(async (org: string, fn: (tx: any) => Promise<unknown>) => {
      if (!org) throw new Error('withTenant requires an organizationId');
      const tx = {
        $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise.resolve(run(org, s, v)),
        $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise.resolve(run(org, s, v)),
        fileEntry: { deleteMany: jest.fn(async () => ({ count: 0 })) },
      };
      return fn(tx);
    }),
  };
  // The bare connection: any file_* query outside withTenant is a test failure.
  const prisma: any = {
    $queryRaw: jest.fn(async () => { throw new Error('query outside withTenant'); }),
    $executeRaw: jest.fn(async () => { throw new Error('query outside withTenant'); }),
    connector: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  };
  return { repo, prisma, log, tenantsCalls };
}

/** Syncs that are still "running"; afterEach finishes them so no lease timer outlives a test. */
const pending: Array<() => void> = [];
const hang = () => new Promise((resolve) => pending.push(() => resolve({ status: 'skipped' })));

function make(db: ReturnType<typeof fakeDb>, opts: { concurrency?: number; worker?: string; run?: () => Promise<any> } = {}) {
  const sync: any = { run: jest.fn(opts.run ?? hang) };
  const scans: any = { run: jest.fn(hang), redescribe: jest.fn(hang) };
  const shares: any = { sweep: jest.fn(async () => 0) };
  const s = new Scheduler(db.prisma, db.repo, sync, scans, shares, opts.worker ?? 'w1', opts.concurrency ?? 2);
  (s as any).lastSweep = Date.now();
  return { s: s as any, sync, scans, shares };
}

const claimsOf = (db: ReturnType<typeof fakeDb>) =>
  db.log.filter((l) => l.sql.includes('UPDATE file_sources SET lease_owner = ?')).map((l) => l.org);

describe('Scheduler (per-workspace maintenance, #1418)', () => {
  afterEach(async () => {
    jest.useRealTimers();
    pending.splice(0).forEach((finish) => finish());
    await new Promise((r) => setImmediate(r));
  });

  it('surveys every workspace in its own tenant transaction and never queries the bare connection', async () => {
    const db = fakeDb([
      { connectorId: 'a1', org: 'org-a', nextSyncAt: ago(10) },
      { connectorId: 'b1', org: 'org-b', nextSyncAt: ago(20) },
    ]);
    const { s } = make(db);
    await s.tick();
    const surveyed = db.log.filter((l) => l.sql.includes('SELECT s.connector_id, s.next_sync_at')).map((l) => l.org);
    expect(surveyed).toEqual(['org-a', 'org-b']);
    expect(db.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(db.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('claims the most overdue source first across workspaces', async () => {
    const db = fakeDb([
      { connectorId: 'a1', org: 'org-a', nextSyncAt: ago(10) },
      { connectorId: 'c1', org: 'org-c', nextSyncAt: ago(1) },
      { connectorId: 'b1', org: 'org-b', nextSyncAt: ago(20) },
    ]);
    const { s, sync } = make(db, { concurrency: 2 });
    await s.tick();
    expect(claimsOf(db)).toEqual(['org-b', 'org-a']);
    expect(sync.run.mock.calls.map((c: any[]) => c[0])).toEqual(['b1', 'a1']);
    expect(s.busy.syncs).toBe(2);
  });

  it('claims at most one source per workspace per tick, and none while the workspace holds a lease', async () => {
    const db = fakeDb([
      { connectorId: 'a1', org: 'org-a', nextSyncAt: ago(10) },
      { connectorId: 'a2', org: 'org-a', nextSyncAt: ago(30) },
      { connectorId: 'b1', org: 'org-b', nextSyncAt: ago(20) },
      { connectorId: 'b2', org: 'org-b', nextSyncAt: ago(5), leaseOwner: 'other', leaseUntil: new Date(Date.now() + 60_000) },
    ]);
    const { s, sync } = make(db, { concurrency: 5 });
    await s.tick();
    expect(sync.run.mock.calls.map((c: any[]) => c[0])).toEqual(['a2']);
    await s.tick();
    expect(sync.run).toHaveBeenCalledTimes(1);
  });

  it('two workers never sync the same workspace at once', async () => {
    const db = fakeDb([
      { connectorId: 'a1', org: 'org-a', nextSyncAt: ago(10) },
      { connectorId: 'a2', org: 'org-a', nextSyncAt: ago(9) },
    ]);
    const w1 = make(db, { worker: 'w1', concurrency: 2 });
    const w2 = make(db, { worker: 'w2', concurrency: 2 });
    await Promise.all([w1.s.tick(), w2.s.tick()]);
    expect(w1.sync.run.mock.calls.length + w2.sync.run.mock.calls.length).toBe(1);
  });

  it('carries the organizationId through lease renewal and release', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let finish!: () => void;
    const db = fakeDb([{ connectorId: 'a1', org: 'org-a', nextSyncAt: ago(10) }]);
    const { s } = make(db, { run: () => new Promise((r) => (finish = () => r({ status: 'ok' }))) });
    await s.tick();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    const renew = db.log.find((l) => l.sql.includes('SET lease_until = now()'))!;
    expect(renew).toMatchObject({ org: 'org-a', values: [10, 'a1', 'org-a', 'w1'] });
    finish();
    await Promise.all([...s.running.values()]);
    const release = db.log.find((l) => l.sql.includes('SET lease_owner = NULL'))!;
    expect(release).toMatchObject({ org: 'org-a', values: ['a1', 'org-a', 'w1'] });
    expect(s.leases.size).toBe(0);
  });

  it('stop() releases every lease this worker holds, each in its workspace', async () => {
    const db = fakeDb([
      { connectorId: 'a1', org: 'org-a', nextSyncAt: ago(10) },
      { connectorId: 'b1', org: 'org-b', nextSyncAt: ago(20) },
    ]);
    const { s } = make(db, { concurrency: 2 });
    const claimed = await s.claimDue([await s.survey('org-a', true), await s.survey('org-b', true)], 2);
    expect(claimed).toEqual([
      { connectorId: 'b1', organizationId: 'org-b' },
      { connectorId: 'a1', organizationId: 'org-a' },
    ]);
    await s.stop();
    const releases = db.log.filter((l) => l.sql.includes('SET lease_owner = NULL'));
    expect(releases.map((l) => [l.org, l.values])).toEqual(
      expect.arrayContaining([
        ['org-a', ['a1', 'org-a', 'w1']],
        ['org-b', ['b1', 'org-b', 'w1']],
      ]),
    );
    expect(releases).toHaveLength(2);
    expect(s.leases.size).toBe(0);
  });

  it('claims queued scans oldest first across workspaces, two at a time, each in its workspace', async () => {
    const db = fakeDb(
      [],
      [
        { id: 's-a', org: 'org-a', status: 'queued', createdAt: ago(1) },
        { id: 's-b', org: 'org-b', status: 'queued', createdAt: ago(3) },
        { id: 's-c', org: 'org-c', status: 'describing', createdAt: ago(2) },
      ],
    );
    const { s, scans } = make(db);
    await s.tick();
    expect(scans.run).toHaveBeenCalledWith('s-b', 'org-b');
    expect(scans.redescribe).toHaveBeenCalledWith('s-c', 'org-c');
    expect(scans.run).not.toHaveBeenCalledWith('s-a', 'org-a');
  });

  it('sweeps one workspace at a time and hands the workspace list to the share sweep', async () => {
    const db = fakeDb([
      { connectorId: 'a1', org: 'org-a', nextSyncAt: new Date(Date.now() + 60_000), state: 'draft' },
      { connectorId: 'b1', org: 'org-b', nextSyncAt: new Date(Date.now() + 60_000) },
    ]);
    const { s, shares } = make(db);
    s.lastSweep = 0;
    await s.tick();
    expect(shares.sweep).toHaveBeenCalledWith(['org-a', 'org-b']);
    const drafts = db.log.filter((l) => l.sql.includes("setup_state = 'draft'")).map((l) => l.org);
    expect(drafts).toEqual(['org-a', 'org-b']);
  });

  it('caches the workspace list for 30 seconds; a kick refreshes it', async () => {
    const db = fakeDb([{ connectorId: 'a1', org: 'org-a', nextSyncAt: new Date(Date.now() + 60_000) }]);
    const { s } = make(db);
    await s.tick();
    await s.tick();
    expect(db.tenantsCalls.n).toBe(1);
    s.kick();
    await s.tick();
    expect(db.tenantsCalls.n).toBe(2);
  });

  it('a failing workspace does not stop the others', async () => {
    const db = fakeDb([
      { connectorId: 'a1', org: 'org-a', nextSyncAt: ago(10) },
      { connectorId: 'b1', org: 'org-b', nextSyncAt: ago(5) },
    ]);
    const inner = db.repo.withTenant.getMockImplementation();
    db.repo.withTenant.mockImplementation((org: string, fn: any) => (org === 'org-a' ? Promise.reject(new Error('boom')) : inner(org, fn)));
    const { s, sync } = make(db);
    await s.tick();
    expect(sync.run.mock.calls.map((c: any[]) => c[0])).toEqual(['b1']);
  });
});
