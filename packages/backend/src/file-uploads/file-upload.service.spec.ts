import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FileUploadService } from './file-upload.service';
import { LocalFileStorage } from '../file-search/storage/file-storage';

const ORG = 'org-a';
const OTHER = 'org-b';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);

/** Just enough of Prisma's `where` for the queries the service makes. */
function matches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as any[]).some((c) => matches(row, c));
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('gt' in cond && !(v != null && v > cond.gt)) return false;
      if ('gte' in cond && !(v != null && v >= cond.gte)) return false;
      if ('lt' in cond && !(v != null && v < cond.lt)) return false;
      if ('lte' in cond && !(v != null && v <= cond.lte)) return false;
      if ('in' in cond && !cond.in.includes(v)) return false;
      return true;
    }
    return cond === null ? v == null : v === cond;
  });
}

function apply(row: Record<string, any>, data: Record<string, any>) {
  for (const [k, v] of Object.entries(data)) {
    row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] ?? 0) + v.increment : v;
  }
}

function fakePrisma(plan: string | null = 'starter') {
  const rows: Record<string, any>[] = [];
  const fileUpload = {
    rows,
    create: jest.fn(async ({ data }) => {
      const row = { state: 'pending', useCount: 0, publicDownloads: 0, purgedAt: null, expiresAt: null, bytes: null, mimeType: null, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    findUnique: jest.fn(async ({ where }) => rows.find((r) => matches(r, where)) ?? null),
    findFirst: jest.fn(async ({ where }) => rows.find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async ({ where, take }) => rows.filter((r) => matches(r, where)).slice(0, take ?? rows.length)),
    count: jest.fn(async ({ where }) => rows.filter((r) => matches(r, where)).length),
    aggregate: jest.fn(async ({ where }) => ({ _sum: { bytes: rows.filter((r) => matches(r, where)).reduce((s, r) => s + (r.bytes ?? 0), 0) } })),
    update: jest.fn(async ({ where, data }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error('not found');
      apply(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => apply(r, data));
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async ({ where }) => {
      const keep = rows.filter((r) => !matches(r, where));
      const n = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count: n };
    }),
  };
  const license = {
    findFirst: jest.fn(async () => (plan ? { plan, expiresAt: null } : null)),
  };
  return { fileUpload, license } as any;
}

describe('FileUploadService', () => {
  let dir: string;
  let prisma: ReturnType<typeof fakePrisma>;
  let svc: FileUploadService;
  const env = { ...process.env };

  function make(opts: { cloud?: boolean; plan?: string | null } = {}) {
    prisma = fakePrisma(opts.plan === undefined ? 'starter' : opts.plan);
    const deployment = { isCloud: () => opts.cloud ?? true } as any;
    svc = new FileUploadService(prisma, deployment);
    (svc as any).storageInstance = new LocalFileStorage(dir);
  }

  const tokenOf = (url: string) => url.split('/u/')[1];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'upload-spec-'));
    process.env.ENCRYPTION_KEY = 'test-key';
    process.env.SERVER_URL = 'https://cloud.example.com';
    delete process.env.FILE_UPLOADS_ENABLED;
    make();
  });

  afterEach(async () => {
    process.env = { ...env };
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a one-time link with the plan cap and a reference', async () => {
    const link = await svc.createLink({ organizationId: ORG, filename: 'cover.png' });
    expect(link.upload_url).toMatch(/^https:\/\/cloud\.example\.com\/api\/uploads\/u\/[A-Za-z0-9_-]{32}$/);
    expect(link.file_ref).toMatch(/^amcp-file:[a-f0-9]{24}$/);
    expect(link.max_bytes).toBe(50 * 1024 * 1024);
    expect(link.file_kept_hours).toBe(8);
    expect(prisma.fileUpload.rows[0].tokenHash).not.toContain(tokenOf(link.upload_url));
  });

  it('offers a browser page with the same token and reports the link state', async () => {
    process.env.FRONTEND_URL = 'https://cloud.example.com';
    const link = await svc.createLink({ organizationId: ORG, filename: 'cover.png' });
    const token = tokenOf(link.upload_url);
    expect(link.browser_upload_url).toBe(`https://cloud.example.com/upload/${token}`);
    expect(link.filename).toBe('cover.png');
    await expect(svc.linkStatus(token)).resolves.toMatchObject({ filename: 'cover.png', state: 'waiting', bytes: null });
    await svc.receive(token, Readable.from([PNG]), PNG.length);
    await expect(svc.linkStatus(token)).resolves.toMatchObject({ state: 'uploaded', bytes: PNG.length });
    prisma.fileUpload.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.linkStatus(token)).resolves.toMatchObject({ state: 'expired' });
    await expect(svc.linkStatus('x'.repeat(32))).rejects.toThrow(/does not exist/);
  });

  it('refuses program files, missing extensions, oversize and a Cloud workspace without a plan', async () => {
    await expect(svc.createLink({ organizationId: ORG, filename: 'setup.exe' })).rejects.toThrow(/Program files/);
    await expect(svc.createLink({ organizationId: ORG, filename: 'noext' })).rejects.toThrow(/extension/);
    await expect(svc.createLink({ organizationId: ORG, filename: 'big.zip', sizeBytes: 60 * 1024 * 1024 })).rejects.toThrow(/up to 50 MB/);
    make({ plan: null });
    await expect(svc.createLink({ organizationId: ORG, filename: 'a.png' })).rejects.toThrow(/active plan/);
  });

  it('works on self-hosted without any licence (every edition)', async () => {
    make({ cloud: false, plan: null });
    const link = await svc.createLink({ organizationId: ORG, filename: 'a.png' });
    expect(link.max_bytes).toBe(100 * 1024 * 1024);
  });

  it('enforces the daily count per plan and the kill switch', async () => {
    make({ plan: 'trial' });
    for (let i = 0; i < 50; i++) await svc.createLink({ organizationId: ORG, filename: `f${i}.png` });
    await expect(svc.createLink({ organizationId: ORG, filename: 'one-more.png' })).rejects.toThrow(/50 uploads per day/);
    await expect(svc.createLink({ organizationId: OTHER, filename: 'other.png' })).resolves.toBeDefined();
    process.env.FILE_UPLOADS_ENABLED = 'false';
    await expect(svc.createLink({ organizationId: OTHER, filename: 'x.png' })).rejects.toThrow(/switched off/);
  });

  it('receives the file once, sniffs its type and resolves it only for the same workspace', async () => {
    const link = await svc.createLink({ organizationId: ORG, filename: 'cover.png' });
    const token = tokenOf(link.upload_url);
    const res = await svc.receive(token, Readable.from([PNG.subarray(0, 5), PNG.subarray(5)]), PNG.length);
    expect(res).toMatchObject({ file_ref: link.file_ref, bytes: PNG.length, public_url_possible: true });
    expect(prisma.fileUpload.rows[0]).toMatchObject({ state: 'ready', mimeType: 'image/png' });

    await expect(svc.receive(token, Readable.from([PNG]), PNG.length)).rejects.toThrow(/already used/);

    const file = await svc.resolveForEngine(link.file_ref, ORG);
    expect(file.buffer.equals(PNG)).toBe(true);
    expect(file).toMatchObject({ filename: 'cover.png', contentType: 'image/png' });
    expect(prisma.fileUpload.rows[0].useCount).toBe(1);

    await expect(svc.resolveForEngine(link.file_ref, OTHER)).rejects.toThrow(/unknown or has expired/);
    await expect(svc.resolveForEngine(link.file_ref, undefined)).rejects.toThrow(/unknown or has expired/);
  });

  it('aborts an upload past the cap while streaming and marks the link failed', async () => {
    make({ cloud: false, plan: null });
    process.env.FILE_UPLOADS_MAX_FILE_BYTES = '100';
    const link = await svc.createLink({ organizationId: ORG, filename: 'big.zip' });
    await expect(svc.receive(tokenOf(link.upload_url), Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), null)).rejects.toThrow(/larger than/);
    expect(prisma.fileUpload.rows[0].state).toBe('failed');
  });

  it('refuses a declared Content-Length over the cap before reading, and an empty body', async () => {
    const link = await svc.createLink({ organizationId: ORG, filename: 'a.zip' });
    await expect(svc.receive(tokenOf(link.upload_url), Readable.from([]), 51 * 1024 * 1024)).rejects.toThrow(/larger than/);
    expect(prisma.fileUpload.rows[0].state).toBe('pending');
    await expect(svc.receive(tokenOf(link.upload_url), Readable.from([]), 0)).rejects.toThrow(/empty/);
  });

  it('refuses an expired link', async () => {
    const link = await svc.createLink({ organizationId: ORG, filename: 'a.png' });
    prisma.fileUpload.rows[0].uploadBy = new Date(Date.now() - 1000);
    await expect(svc.receive(tokenOf(link.upload_url), Readable.from([PNG]), PNG.length)).rejects.toThrow(/expired/);
  });

  it('issues public URLs only for media whose bytes match, verifies the signature and caps downloads', async () => {
    const link = await svc.createLink({ organizationId: ORG, filename: 'cover.png' });
    await svc.receive(tokenOf(link.upload_url), Readable.from([PNG]), PNG.length);
    const pub = await svc.publicUrl(link.file_ref, ORG);
    const signed = pub.public_url.split('/api/uploads/f/')[1].split('/')[0];
    const file = await svc.openPublic(signed);
    expect(file.mimeType).toBe('image/png');
    file.stream.destroy();

    await expect(svc.publicUrl(link.file_ref, OTHER)).rejects.toThrow(/unknown or has expired/);
    await expect(svc.openPublic(signed.replace(/.$/, signed.endsWith('A') ? 'B' : 'A'))).rejects.toThrow(/Invalid link/);
    // Every other spelling of the last character is refused, including ones that decode to the same bytes.
    const sig = signed.split('.')[3];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const c of alphabet) {
      if (c === sig.slice(-1)) continue;
      await expect(svc.openPublic(signed.slice(0, -1) + c)).rejects.toThrow(/Invalid link/);
    }

    prisma.fileUpload.rows[0].publicDownloads = 50;
    await expect(svc.openPublic(signed)).rejects.toThrow(/no longer available/);

    // A ".png" that is really HTML never gets a public link.
    const fake = await svc.createLink({ organizationId: ORG, filename: 'fake.png' });
    await svc.receive(tokenOf(fake.upload_url), Readable.from([Buffer.from('<html><script>x</script></html>')]), null);
    await expect(svc.publicUrl(fake.file_ref, ORG)).rejects.toThrow(/Public links are only made/);
    // ZIPs stay reference-only.
    const zip = await svc.createLink({ organizationId: ORG, filename: 'pack.zip' });
    await svc.receive(tokenOf(zip.upload_url), Readable.from([Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])]), null);
    await expect(svc.publicUrl(zip.file_ref, ORG)).rejects.toThrow(/Public links are only made/);
  });

  it('sweeps expired files and dead links, and keeps live ones', async () => {
    const live = await svc.createLink({ organizationId: ORG, filename: 'live.png' });
    await svc.receive(tokenOf(live.upload_url), Readable.from([PNG]), PNG.length);
    const old = await svc.createLink({ organizationId: ORG, filename: 'old.png' });
    await svc.receive(tokenOf(old.upload_url), Readable.from([PNG]), PNG.length);
    await svc.createLink({ organizationId: ORG, filename: 'never.png' });
    const [rLive, rOld, rNever] = prisma.fileUpload.rows;
    rOld.expiresAt = new Date(Date.now() - 1000);
    rNever.uploadBy = new Date(Date.now() - 2 * 3600_000);

    expect(await svc.sweep()).toBe(2);
    expect(rOld.state).toBe('purged');
    expect(rNever.state).toBe('purged');
    expect(rLive.state).toBe('ready');
    await expect(svc.resolveForEngine(old.file_ref, ORG)).rejects.toThrow(/unknown or has expired/);
    await expect(svc.storage.open(rOld.storageKey)).rejects.toThrow();
    await expect(svc.resolveForEngine(live.file_ref, ORG)).resolves.toBeDefined();
  });
});
