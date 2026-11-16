import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { fileStorageFromEnv, type FileStorage } from '../file-search/storage/file-storage';
import { BLOCKED_EXT, mimeFor, safeFilename } from '../file-search/file-share.service';
import { globalUploadLimits, uploadQuotaFor, type FileUploadQuota } from './file-upload-quotas';
import { extOf, mimeForUpload, publicAllowed, sniffType, SNIFF_BYTES } from './file-upload-sniff';
import { FILE_REF_PREFIX, FILE_REF_RE, FILE_UPLOAD_LINK_TOOL } from './file-upload-params';

const MB = 1024 * 1024;
/** How long an upload link can be used. */
const LINK_TTL_MS = 15 * 60_000;
/** How long one public URL works (never past the file's own expiry). */
const PUBLIC_URL_TTL_S = 60 * 60;
/** Fetches per file across all its public URLs (providers retry and make thumbnails). */
const MAX_PUBLIC_DOWNLOADS = 50;
/** Uploads received at the same time by one backend process. */
const MAX_CONCURRENT_UPLOADS = 8;
const SWEEP_MS = 10 * 60_000;
const SWEEP_FIRST_MS = 60_000;
/** Purged rows are kept this long for the audit, then deleted. */
const PURGED_RETENTION_MS = 30 * 24 * 3600_000;

/** The same text for unknown, used, expired or foreign references: no existence oracle. */
const UNKNOWN_REF =
  `This file reference is unknown or has expired. Upload the file again with ${FILE_UPLOAD_LINK_TOOL}.`;

export interface UploadedFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Agent file uploads: an AI client asks for a one-time link (file_upload_link),
 * its code sandbox sends the file there with curl, and connector tools then use
 * the file by reference (`amcp-file:<id>` in a __file parameter) or through a
 * short-lived public URL for providers that fetch files themselves.
 *
 * Works in both deployments: Cloud stores in the File Share bucket under
 * `uploads/<orgId>/<id>` with per-plan caps; self-hosted uses its own File
 * Share storage (local directory or S3), every edition, caps only if set.
 */
@Injectable()
export class FileUploadService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileUploadService.name);
  private storageInstance: FileStorage | null = null;
  private active = 0;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private firstSweep?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const sweep = () => void this.sweep().catch((err) => this.logger.warn(`upload sweep: ${(err as Error).message}`));
    this.firstSweep = setTimeout(sweep, SWEEP_FIRST_MS);
    this.firstSweep.unref?.();
    this.sweepTimer = setInterval(sweep, SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstSweep) clearTimeout(this.firstSweep);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  get storage(): FileStorage {
    if (!this.storageInstance) this.storageInstance = fileStorageFromEnv();
    return this.storageInstance;
  }

  /** Switched on for this instance (FILE_UPLOADS_ENABLED, default on). */
  enabled(): boolean {
    return globalUploadLimits(this.deployment.isCloud()).enabled;
  }

  private baseUrl(): string {
    return (process.env.FILES_DOWNLOAD_BASE_URL || process.env.SERVER_URL || 'http://localhost:4000').replace(/\/+$/, '');
  }

  private signingKey(): Buffer {
    const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!secret) throw new Error('ENCRYPTION_KEY is required for file uploads');
    return createHash('sha256').update(`file-upload-public:${secret}`).digest();
  }

  /** The workspace's limits, or null when it may not upload (Cloud without an active plan). */
  async quota(organizationId: string, now = new Date()): Promise<FileUploadQuota | null> {
    const cloud = this.deployment.isCloud();
    if (!cloud) return uploadQuotaFor(null, { cloud });
    const lic = await this.prisma.license.findFirst({
      where: { organizationId, status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: { plan: true, expiresAt: true },
    });
    if (!lic || (lic.expiresAt && lic.expiresAt < now)) return null;
    return uploadQuotaFor(lic.plan, { cloud });
  }

  /** file_upload_link: a one-time upload URL and the reference the file will have. */
  async createLink(input: {
    organizationId: string;
    userId?: string | null;
    mcpServerId?: string | null;
    filename: string;
    sizeBytes?: number | null;
  }) {
    const cloud = this.deployment.isCloud();
    const global = globalUploadLimits(cloud);
    if (!global.enabled) throw new ForbiddenException('File uploads are switched off on this instance.');
    const quota = await this.quota(input.organizationId);
    if (!quota) throw new ForbiddenException('File uploads need an active plan. A workspace administrator can choose one.');

    const filename = safeFilename(input.filename);
    const ext = extOf(filename);
    if (!ext) throw new BadRequestException('Give the file name with its extension, e.g. "cover.png" or "pattern.zip".');
    if (BLOCKED_EXT.has(ext)) throw new BadRequestException(`Program files (${ext}) cannot be uploaded.`);
    if (input.sizeBytes != null && input.sizeBytes > quota.maxFileBytes) {
      throw new BadRequestException(
        `The file is ${(input.sizeBytes / MB).toFixed(1)} MB; this plan uploads files up to ${(quota.maxFileBytes / MB).toFixed(0)} MB.`,
      );
    }

    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const live = { state: 'ready', expiresAt: { gt: now } };
    const [today, stored, globalToday, globalStored] = await Promise.all([
      quota.uploadsPerDay != null
        ? this.prisma.fileUpload.count({ where: { organizationId: input.organizationId, createdAt: { gte: dayStart } } })
        : Promise.resolve(0),
      quota.maxStoredBytes != null
        ? this.prisma.fileUpload.aggregate({ where: { organizationId: input.organizationId, ...live }, _sum: { bytes: true } })
        : Promise.resolve(null),
      global.dailyBytes != null
        ? this.prisma.fileUpload.aggregate({ where: { createdAt: { gte: dayStart } }, _sum: { bytes: true } })
        : Promise.resolve(null),
      global.storedBytes != null
        ? this.prisma.fileUpload.aggregate({ where: live, _sum: { bytes: true } })
        : Promise.resolve(null),
    ]);
    if (quota.uploadsPerDay != null && today >= quota.uploadsPerDay) {
      throw new ForbiddenException(`This plan allows ${quota.uploadsPerDay} uploads per day. Try again tomorrow or upgrade.`);
    }
    if (quota.maxStoredBytes != null && (stored?._sum.bytes ?? 0) >= quota.maxStoredBytes) {
      throw new ForbiddenException(
        `The uploaded files kept right now reach this plan's ${(quota.maxStoredBytes / MB).toFixed(0)} MB. They are deleted ${quota.ttlHours} hours after upload; try again later.`,
      );
    }
    if (
      (global.dailyBytes != null && (globalToday?._sum.bytes ?? 0) >= global.dailyBytes) ||
      (global.storedBytes != null && (globalStored?._sum.bytes ?? 0) >= global.storedBytes)
    ) {
      this.logger.warn('File uploads: an instance-wide limit is reached; new upload links are refused');
      throw new HttpException('File uploads are busy right now. Try again in an hour.', HttpStatus.SERVICE_UNAVAILABLE);
    }

    const id = randomBytes(12).toString('hex');
    const token = randomBytes(24).toString('base64url');
    const uploadBy = new Date(now.getTime() + LINK_TTL_MS);
    await this.prisma.fileUpload.create({
      data: {
        id,
        organizationId: input.organizationId,
        createdByUserId: input.userId ?? null,
        mcpServerId: input.mcpServerId ?? null,
        filename,
        maxBytes: quota.maxFileBytes,
        storageKey: `uploads/${input.organizationId}/${id}`,
        tokenHash: sha256(token),
        uploadBy,
      },
    });
    const uploadUrl = `${this.baseUrl()}/api/uploads/u/${token}`;
    const host = new URL(this.baseUrl()).host;
    return {
      upload_url: uploadUrl,
      method: 'PUT',
      command: `curl -sS -H 'Content-Type: application/octet-stream' -T '<path to ${filename}>' '${uploadUrl}'`,
      file_ref: `${FILE_REF_PREFIX}${id}`,
      max_bytes: quota.maxFileBytes,
      link_expires_at: uploadBy.toISOString(),
      file_kept_hours: quota.ttlHours,
      next:
        'Run the command in your code sandbox. Its answer repeats file_ref; pass file_ref as the file parameter of the connector tool ' +
        '(for example file_url or image_url). For a tool that wants a public link (an image src or URL field), call file_public_url with file_ref.',
      if_blocked:
        `If curl fails with 403, "blocked-by-allowlist" or a network error, the sandbox cannot reach ${host}. ` +
        `Tell the user to allow ${host} in their AI app's code-execution network settings (Claude: Settings → Capabilities) and to start a new chat; or ask them for a public link to the file instead.`,
    };
  }

  /**
   * PUT /api/uploads/u/:token. The token is the credential; it works once,
   * within 15 minutes. The body is streamed to a temp file with a hard size cap,
   * then to storage.
   */
  async receive(token: string, body: Readable, contentLength?: number | null) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('This upload link does not exist.');
    const row = await this.prisma.fileUpload.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row) throw new NotFoundException('This upload link does not exist.');
    if (row.state !== 'pending') throw new ConflictException('This upload link was already used. Ask for a new one.');
    if (row.uploadBy <= new Date()) throw new GoneException('This upload link has expired. Ask for a new one.');
    if (contentLength != null && contentLength > row.maxBytes) {
      throw new PayloadTooLargeException(`The file is larger than ${(row.maxBytes / MB).toFixed(0)} MB, the limit of this plan.`);
    }
    if (this.active >= MAX_CONCURRENT_UPLOADS) {
      throw new HttpException('Too many uploads right now. Try again in a minute.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const claimed = await this.prisma.fileUpload.updateMany({
      where: { id: row.id, organizationId: row.organizationId, state: 'pending' },
      data: { state: 'uploading' },
    });
    if (claimed.count !== 1) throw new ConflictException('This upload link was already used. Ask for a new one.');

    this.active++;
    const dir = await mkdtemp(join(tmpdir(), 'amcp-upload-'));
    const tmp = join(dir, 'body');
    try {
      const { bytes, hash, head } = await this.spool(body, tmp, row.maxBytes);
      if (bytes === 0) throw new BadRequestException('The upload was empty. Send the file as the request body (curl -T <file>).');
      const mimeType = mimeForUpload(row.filename, sniffType(head), (n) => mimeFor(n));
      await this.storage.putStream(row.storageKey, createReadStream(tmp), bytes, mimeType);
      const quota = await this.quota(row.organizationId);
      const ttlHours = quota?.ttlHours ?? 8;
      const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
      await this.prisma.fileUpload.update({
        where: { id: row.id },
        data: { state: 'ready', bytes, sha256: hash, mimeType, expiresAt },
      });
      this.logger.log(`File upload received id=${row.id} org=${row.organizationId} bytes=${bytes}`);
      return {
        file_ref: `${FILE_REF_PREFIX}${row.id}`,
        filename: row.filename,
        bytes,
        sha256: hash,
        expires_at: expiresAt.toISOString(),
        public_url_possible: publicAllowed(row.filename, mimeType),
      };
    } catch (err) {
      await this.prisma.fileUpload
        .update({ where: { id: row.id }, data: { state: 'failed' } })
        .catch(() => undefined);
      await this.storage.delete(row.storageKey).catch(() => undefined);
      throw err;
    } finally {
      this.active--;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Writes the body to `path`, counting and hashing; aborts past maxBytes. */
  private spool(body: Readable, path: string, maxBytes: number): Promise<{ bytes: number; hash: string; head: Buffer }> {
    return new Promise((resolve, reject) => {
      const out = createWriteStream(path, { mode: 0o600 });
      const hash = createHash('sha256');
      const headParts: Buffer[] = [];
      let headLen = 0;
      let bytes = 0;
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        body.unpipe(out);
        body.resume();
        out.destroy();
        reject(err);
      };
      body.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          fail(new PayloadTooLargeException(`The file is larger than ${(maxBytes / MB).toFixed(0)} MB, the limit of this plan.`));
          return;
        }
        hash.update(chunk);
        if (headLen < SNIFF_BYTES) {
          headParts.push(chunk.subarray(0, SNIFF_BYTES - headLen));
          headLen += Math.min(chunk.length, SNIFF_BYTES - headLen);
        }
      });
      body.on('error', (err) => fail(err));
      body.on('aborted', () => fail(new BadRequestException('The upload was interrupted.')));
      out.on('error', (err) => fail(err));
      out.on('finish', () => {
        if (!failed) resolve({ bytes, hash: hash.digest('hex'), head: Buffer.concat(headParts) });
      });
      body.pipe(out);
    });
  }

  private async readyRow(ref: string, organizationId: string) {
    const m = FILE_REF_RE.exec(ref.trim());
    if (!m) return null;
    return this.prisma.fileUpload.findFirst({
      where: { id: m[1], organizationId, state: 'ready', expiresAt: { gt: new Date() } },
    });
  }

  /**
   * For the REST engine: the bytes behind `amcp-file:<id>`, only for a tool
   * call of the workspace that uploaded it.
   */
  async resolveForEngine(ref: string, organizationId: string | undefined): Promise<UploadedFile> {
    if (!organizationId) throw new Error(UNKNOWN_REF);
    const row = await this.readyRow(ref, organizationId);
    if (!row) throw new Error(UNKNOWN_REF);
    const { stream } = await this.storage.open(row.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    await this.prisma.fileUpload
      .updateMany({ where: { id: row.id, organizationId }, data: { useCount: { increment: 1 } } })
      .catch(() => undefined);
    return { buffer: Buffer.concat(chunks), filename: row.filename, contentType: row.mimeType || 'application/octet-stream' };
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.signingKey()).update(`public-v1:${payload}`).digest();
  }

  /** file_public_url: a direct download link valid for an hour, for media files only. */
  async publicUrl(ref: string, organizationId: string) {
    if (!this.enabled()) throw new ForbiddenException('File uploads are switched off on this instance.');
    const row = await this.readyRow(ref, organizationId);
    if (!row) throw new NotFoundException(UNKNOWN_REF);
    if (!publicAllowed(row.filename, row.mimeType)) {
      throw new BadRequestException(
        'Public links are only made for images (JPG, PNG, GIF, WebP), videos (MP4, MOV) and PDFs whose content matches the extension. ' +
          'Pass the file_ref directly to a tool parameter that takes a file instead.',
      );
    }
    if (row.publicDownloads >= MAX_PUBLIC_DOWNLOADS) throw new GoneException('This file has been downloaded too often. Upload it again.');
    const exp = Math.min(Math.floor(Date.now() / 1000) + PUBLIC_URL_TTL_S, Math.floor(row.expiresAt!.getTime() / 1000));
    const payload = `${row.id}.${row.organizationId}.${exp}`;
    const sig = this.sign(payload).toString('base64url');
    return {
      public_url: `${this.baseUrl()}/api/uploads/f/${payload}.${sig}/${encodeURIComponent(row.filename)}`,
      expires_at: new Date(exp * 1000).toISOString(),
      note: 'Anyone with this link can download the file until it expires. Use it right away in the tool that needs a URL; call file_public_url again for a fresh one.',
    };
  }

  /** GET /api/uploads/f/:signed — verifies the signature and streams the file. */
  async openPublic(signed: string): Promise<{ stream: Readable; filename: string; mimeType: string; bytes: number }> {
    const m = signed.match(/^([a-f0-9]{24})\.([A-Za-z0-9_-]{1,100})\.(\d{10})\.([A-Za-z0-9_-]{20,})$/);
    if (!m) throw new NotFoundException('Invalid link.');
    const [, id, organizationId, expRaw, sig] = m;
    const expected = this.sign(`${id}.${organizationId}.${expRaw}`);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new NotFoundException('Invalid link.');
    if (Number(expRaw) < Math.floor(Date.now() / 1000)) throw new GoneException('This link has expired.');
    const counted = await this.prisma.fileUpload.updateMany({
      where: { id, organizationId, state: 'ready', expiresAt: { gt: new Date() }, publicDownloads: { lt: MAX_PUBLIC_DOWNLOADS } },
      data: { publicDownloads: { increment: 1 } },
    });
    if (counted.count !== 1) throw new GoneException('This file is no longer available.');
    const row = await this.prisma.fileUpload.findFirst({ where: { id, organizationId } });
    if (!row || !publicAllowed(row.filename, row.mimeType)) throw new GoneException('This file is no longer available.');
    const { stream } = await this.storage.open(row.storageKey);
    return { stream, filename: row.filename, mimeType: row.mimeType!, bytes: row.bytes ?? 0 };
  }

  /**
   * Deletes expired files and dead links, then old purged rows. Runs every 10
   * minutes in every backend process; deletes are idempotent, so two colours of
   * a blue/green deploy sweeping at once only repeat work.
   */
  async sweep(limit = 500): Promise<number> {
    const now = new Date();
    const deadLink = new Date(now.getTime() - 3600_000);
    const rows = await this.prisma.fileUpload.findMany({
      where: {
        purgedAt: null,
        OR: [
          { state: 'ready', expiresAt: { lte: now } },
          { state: { in: ['pending', 'uploading', 'failed'] }, uploadBy: { lte: deadLink } },
        ],
      },
      select: { id: true, organizationId: true, storageKey: true, state: true },
      take: limit,
    });
    let n = 0;
    for (const r of rows) {
      try {
        // Storage first; the row is marked once the file is gone.
        if (r.state !== 'pending') await this.storage.delete(r.storageKey);
        await this.prisma.fileUpload.updateMany({
          where: { id: r.id, organizationId: r.organizationId, purgedAt: null },
          data: { state: 'purged', purgedAt: now },
        });
        n++;
      } catch (err) {
        this.logger.warn(`upload sweep ${r.id}: ${(err as Error).message}`);
      }
    }
    await this.prisma.fileUpload.deleteMany({ where: { purgedAt: { lt: new Date(now.getTime() - PURGED_RETENTION_MS) } } });
    if (n) this.logger.log(`File uploads: removed ${n} expired files or links`);
    return n;
  }
}
