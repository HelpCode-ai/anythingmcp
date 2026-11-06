import { FileShareService, mimeFor, safeFilename } from './file-share.service';

const MB = 1024 * 1024;
function make(limits: any, existing: any[] = []) {
  const rows: any[] = [...existing];
  const prisma: any = {
    organization: { findUnique: jest.fn(async () => ({ name: 'Acme' })) },
    organizationMember: { findFirst: jest.fn(async () => null) },
  };
  // The fake transactions see only what the policies would show: withTenant
  // the rows of its workspace, withShareToken the one row with that hash.
  const scoped = (visible: (r: any) => boolean) => ({
    fileShare: {
      aggregate: jest.fn(async () => ({ _sum: { bytes: rows.filter(visible).reduce((n, r) => n + r.bytes, 0) }, _count: rows.filter(visible).length })),
      count: jest.fn(async () => rows.filter(visible).length),
      create: jest.fn(async ({ data }: any) => { const r = { ...data, createdAt: new Date(), downloadCount: 0, revokedAt: null, purgedAt: null, maxDownloads: null }; rows.push(r); return r; }),
      findUnique: jest.fn(async ({ where }: any) => rows.filter(visible).find((r) => r.tokenHash === where.tokenHash) ?? null),
      findFirst: jest.fn(async ({ where }: any) => rows.filter(visible).find((r) => r.id === where.id && r.organizationId === where.organizationId) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter(visible).filter((r) => r.organizationId === where.organizationId && !r.purgedAt && (r.revokedAt || (r.expiresAt && r.expiresAt <= new Date()))),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const r = rows.filter(visible).find((x) => x.id === where.id && x.organizationId === where.organizationId);
        if (!r) throw new Error('Record to update not found');
        if (data.downloadCount?.increment) r.downloadCount += data.downloadCount.increment;
        else Object.assign(r, data);
        return r;
      }),
    },
  });
  const calls: string[] = [];
  const repo: any = {
    withTenant: jest.fn(async (o: string, fn: any) => (calls.push(`tenant:${o}`), fn(scoped((r) => r.organizationId === o)))),
    withShareToken: jest.fn(async (h: string, fn: any) => (calls.push('token'), fn(scoped((r) => r.tokenHash === h)))),
    tenantsWithFileSearch: jest.fn(async () => [...new Set(rows.map((r) => r.organizationId))]),
  };
  const access: any = { resolve: async () => (limits ? { allowed: true, plan: 'starter', cloud: limits.cloud ?? true, quota: { share: limits, policy: false } } : { allowed: false }) };
  const policy: any = { get: async () => ({ publicLinks: true, maxTtlHours: null, aiDrafting: true, allowPlainFtp: true }) };
  const svc = new FileShareService(prisma, repo, access, policy);
  const stored = new Map<string, Buffer>();
  (svc as any).storageInstance = { kind: 'local', put: async (k: string, b: Buffer) => void stored.set(k, b), open: async (k: string) => ({ stream: require('node:stream').Readable.from([stored.get(k)!]) }), delete: async (k: string) => void stored.delete(k) };
  return { svc, rows, repo, calls, stored, prisma };
}
const STARTER = { maxTtlHours: 24, maxStoredBytes: 100 * MB, maxFileBytes: 10 * MB, maxLinksPerDay: 20, publicLinks: true, internalWithoutExpiry: false };

describe('FileShareService', () => {
  beforeAll(() => { process.env.ENCRYPTION_KEY = 'k'.repeat(32); process.env.FRONTEND_URL = 'https://app.example'; process.env.SERVER_URL = 'https://api.example'; });

  it('helpers: mime types and safe file names', () => {
    expect(mimeFor('a.PDF')).toBe('application/pdf');
    expect(safeFilename('../../etc/"passwd"\n')).toBe('passwd');
  });

  it('refuses programs on the Cloud, files over the plan and links when locked', async () => {
    await expect(make(STARTER).svc.create({ organizationId: 'o', source: 'upload', filename: 'x.exe', bytes: Buffer.from('MZ') })).rejects.toThrow(/Program files/);
    await expect(make(STARTER).svc.create({ organizationId: 'o', source: 'upload', filename: 'big.pdf', bytes: Buffer.alloc(11 * MB) })).rejects.toThrow(/up to 10 MB/);
    await expect(make(null).svc.create({ organizationId: 'o', source: 'upload', filename: 'a.csv', bytes: Buffer.from('a') })).rejects.toMatchObject({ response: { code: 'file_share_locked' } });
  });

  it('caps the validity to the plan and stores only the token hash', async () => {
    const { svc, rows } = make(STARTER);
    const link = await svc.create({ organizationId: 'o', source: 'upload', filename: 'a.csv', bytes: Buffer.from('a;b'), ttlHours: 999, access: 'public' });
    expect(link.url).toMatch(/^https:\/\/app\.example\/f\/[A-Za-z0-9_-]{32}$/);
    const hours = (new Date(link.expiresAt!).getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    expect(JSON.stringify(rows)).not.toContain(link.url.split('/f/')[1]);
  });

  it('internal links need a member; signed download URLs cannot be forged', async () => {
    const { svc } = make(STARTER);
    const link = await svc.create({ organizationId: 'o', source: 'upload', filename: 'a.csv', bytes: Buffer.from('hello'), access: 'internal' });
    const token = link.url.split('/f/')[1];
    await expect(svc.issueDownload(token, null)).rejects.toMatchObject({ response: { code: 'sign_in_required' } });
    const ok = await svc.issueDownload(token, { sub: 'u', organizationId: 'o' });
    const signed = ok.url.split('/d/')[1];
    const file = await svc.openSigned(signed);
    expect(file.filename).toBe('a.csv');
    await expect(svc.openSigned(signed.slice(0, -2) + 'xx')).rejects.toThrow(/Invalid/);
    await expect(svc.issueDownload(token, { sub: 'u2', organizationId: 'other' })).rejects.toThrow(/another workspace/);
  });

  it('lists links a page at a time with the filters in the query', async () => {
    const { svc } = make(STARTER);
    const findMany = jest.fn(async () => []);
    const count = jest.fn(async () => 137);
    (svc as any).repo = { withTenant: (_o: string, fn: any) => fn({ fileShare: { findMany, count } }) };
    (svc as any).prisma.user = { findMany: async () => [] };
    const r = await svc.list('o', { userId: 'u', q: '  nordtor ', access: 'public', page: 3, pageSize: 500 });
    expect(r).toMatchObject({ total: 137, page: 3, pageSize: 100 });
    const arg = (findMany.mock.calls[0] as any)[0];
    expect(arg.skip).toBe(200);
    expect(arg.take).toBe(100);
    expect(arg.where).toMatchObject({ organizationId: 'o', createdByUserId: 'u', access: 'public', filename: { contains: 'nordtor', mode: 'insensitive' }, revokedAt: null });
    expect((count.mock.calls[0] as any)[0].where).toEqual(arg.where);
  });

  it('a link is read by its token hash, its workspace learnt, the download counted inside that workspace', async () => {
    const { svc, rows, repo, calls } = make(STARTER);
    const link = await svc.create({ organizationId: 'org-b', source: 'upload', filename: 'b.csv', bytes: Buffer.from('b'), access: 'public' });
    const token = link.url.split('/f/')[1];
    calls.length = 0;
    expect(await svc.describe(token)).toMatchObject({ filename: 'b.csv', workspace: 'Acme', state: 'active' });
    const hash = require('node:crypto').createHash('sha256').update(token).digest('hex');
    expect(repo.withShareToken).toHaveBeenCalledWith(hash, expect.any(Function));
    const ok = await svc.issueDownload(token, null);
    expect(calls).toEqual(['token', 'token', 'tenant:org-b']);
    expect(rows[0].downloadCount).toBe(1);
    // The signed URL carries the workspace and never the token.
    const signed = ok.url.split('/d/')[1];
    expect(signed.split('.')[1]).toBe('org-b');
    expect(ok.url).not.toContain(token);
    calls.length = 0;
    expect((await svc.openSigned(signed)).filename).toBe('b.csv');
    expect(calls).toEqual(['tenant:org-b']);
    await expect(svc.describe('x'.repeat(32))).rejects.toThrow(/does not exist/);
  });

  it('signed download URLs: the workspace is covered by the signature, the old format is refused', async () => {
    const { svc, repo } = make(STARTER);
    const link = await svc.create({ organizationId: 'org-b', source: 'upload', filename: 'b.csv', bytes: Buffer.from('b'), access: 'public' });
    const signed = (await svc.issueDownload(link.url.split('/f/')[1], null)).url.split('/d/')[1];
    const [id, , exp, sig] = signed.split('.');
    repo.withTenant.mockClear();
    // Another workspace with the same signature: refused before any query.
    await expect(svc.openSigned(`${id}.org-a.${exp}.${sig}`)).rejects.toThrow(/Invalid/);
    // The pre-#1418 form <id>.<exp>.<sig> (signed URLs lived 60 seconds).
    const { createHmac, createHash } = require('node:crypto');
    const key = createHash('sha256').update(`file-share:${process.env.ENCRYPTION_KEY}`).digest();
    const oldSig = createHmac('sha256', key).update(`${id}.${exp}`).digest('base64url');
    await expect(svc.openSigned(`${id}.${exp}.${oldSig}`)).rejects.toThrow(/Invalid/);
    expect(repo.withTenant).not.toHaveBeenCalled();
    // Expired, correctly signed: Gone, still without a query.
    const past = String(Math.floor(Date.now() / 1000) - 5);
    const pastSig = createHmac('sha256', key).update(`download-v2:${id}.org-b.${past}`).digest('base64url');
    await expect(svc.openSigned(`${id}.org-b.${past}.${pastSig}`)).rejects.toThrow(/expired/);
    expect(repo.withTenant).not.toHaveBeenCalled();
  });

  it('sweeps expired and revoked links one workspace at a time', async () => {
    const old = new Date(Date.now() - 1000);
    const base = { bytes: 1, purgedAt: null, revokedAt: null, downloadCount: 0, maxDownloads: null };
    const { svc, rows, calls, stored } = make(STARTER, [
      { ...base, id: 'a1', organizationId: 'org-a', storageKey: 'ka1', expiresAt: old },
      { ...base, id: 'a2', organizationId: 'org-a', storageKey: 'ka2', expiresAt: null },
      { ...base, id: 'b1', organizationId: 'org-b', storageKey: 'kb1', expiresAt: null, revokedAt: old },
    ]);
    for (const k of ['ka1', 'ka2', 'kb1']) stored.set(k, Buffer.from('x'));
    expect(await svc.sweep()).toBe(2);
    expect(calls.every((c) => c.startsWith('tenant:'))).toBe(true);
    expect(new Set(calls)).toEqual(new Set(['tenant:org-a', 'tenant:org-b']));
    expect(rows.find((r) => r.id === 'a2').purgedAt).toBeNull();
    expect([...stored.keys()]).toEqual(['ka2']);
    // A list passed in is used as it is.
    calls.length = 0;
    await svc.sweep(['org-a']);
    expect(calls).toEqual(['tenant:org-a']);
  });
});
