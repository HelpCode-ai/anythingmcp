import { FileShareService, mimeFor, safeFilename } from './file-share.service';

const MB = 1024 * 1024;
function make(limits: any, existing: any[] = []) {
  const rows: any[] = [...existing];
  const prisma: any = {
    fileShare: {
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.tokenHash === where.tokenHash || r.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data)),
    },
    organizationMember: { findFirst: jest.fn(async () => null) },
  };
  const tx: any = {
    fileShare: {
      aggregate: jest.fn(async () => ({ _sum: { bytes: rows.reduce((n, r) => n + r.bytes, 0) }, _count: rows.length })),
      count: jest.fn(async () => rows.length),
      create: jest.fn(async ({ data }: any) => { const r = { ...data, createdAt: new Date(), downloadCount: 0, revokedAt: null, purgedAt: null, maxDownloads: null }; rows.push(r); return r; }),
    },
  };
  const repo: any = { withTenant: (_o: string, fn: any) => fn(tx) };
  const access: any = { resolve: async () => (limits ? { allowed: true, plan: 'starter', cloud: limits.cloud ?? true, quota: { share: limits, policy: false } } : { allowed: false }) };
  const policy: any = { get: async () => ({ publicLinks: true, maxTtlHours: null, aiDrafting: true, allowPlainFtp: true }) };
  const svc = new FileShareService(prisma, repo, access, policy);
  const stored = new Map<string, Buffer>();
  (svc as any).storageInstance = { kind: 'local', put: async (k: string, b: Buffer) => void stored.set(k, b), open: async (k: string) => ({ stream: require('node:stream').Readable.from([stored.get(k)!]) }), delete: async (k: string) => void stored.delete(k) };
  return { svc, rows };
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
});
