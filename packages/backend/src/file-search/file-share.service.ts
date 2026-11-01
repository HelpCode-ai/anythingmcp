import { BadRequestException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PrismaService } from '../common/prisma.service';
import { FileSearchRepository } from './file-search.repository';
import { FileSearchAccessService } from './file-search-access.service';
import { FileSearchPolicyService } from './file-search-policy.service';
import { fileStorageFromEnv, type FileStorage } from './storage/file-storage';

/**
 * File Share (#1387): temporary download links for files from a File Search
 * connector or uploaded by an agent.
 *
 * A link is `<FRONTEND_URL>/f/<token>`: a page that names the file and the
 * workspace (the interstitial), and for internal links asks for a sign-in.
 * The page asks the API for a 60-second signed download URL, which streams
 * the file with `Content-Disposition: attachment`, `nosniff` and a sandbox
 * CSP, so nothing behind a link is ever rendered as a page on our domain.
 * Only the token's SHA-256 is stored.
 */

const MB = 1024 * 1024;
const DOWNLOAD_URL_TTL_S = 60;

/** Program files and scripts are never served from AnythingMCP Cloud. */
const BLOCKED_EXT = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.cpl', '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1',
  '.jar', '.apk', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.sh', '.lnk', '.hta', '.reg', '.iso', '.img', '.dll', '.sys',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.msg': 'application/vnd.ms-outlook',
  '.eml': 'message/rfc822',
};

export function mimeFor(filename: string, fallback = 'application/octet-stream'): string {
  const i = filename.lastIndexOf('.');
  return (i > 0 && MIME_BY_EXT[filename.slice(i).toLowerCase()]) || fallback;
}

export function safeFilename(name: string): string {
  const base = [...((name || 'file').split(/[\\/]/).pop() ?? '')]
    .filter((ch) => ch !== '"' && ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  return base.slice(0, 200) || 'file';
}

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface CreateShareInput {
  organizationId: string;
  userId?: string | null;
  source: 'upload' | 'connector';
  connectorId?: string | null;
  entryPath?: string | null;
  filename: string;
  mimeType?: string;
  bytes: Buffer;
  access?: 'internal' | 'public';
  ttlHours?: number;
}

@Injectable()
export class FileShareService {
  private readonly logger = new Logger(FileShareService.name);
  private storageInstance: FileStorage | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: FileSearchRepository,
    private readonly access: FileSearchAccessService,
    private readonly policy: FileSearchPolicyService,
  ) {}

  get storage(): FileStorage {
    if (!this.storageInstance) this.storageInstance = fileStorageFromEnv();
    return this.storageInstance;
  }

  private signingKey(): Buffer {
    const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!secret) throw new Error('ENCRYPTION_KEY is required for File Share');
    return createHash('sha256').update(`file-share:${secret}`).digest();
  }

  private frontendUrl(): string {
    return (process.env.FRONTEND_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
  }

  private downloadBase(): string {
    return (process.env.FILES_DOWNLOAD_BASE_URL || process.env.SERVER_URL || 'http://localhost:4000').replace(/\/+$/, '');
  }

  /** What the plan and the policy allow right now (for the UI and the tools). */
  async limits(organizationId: string) {
    const a = await this.access.resolve(organizationId);
    if (!a.allowed || !a.quota.share) return null;
    const p = await this.policy.get(organizationId);
    const share = a.quota.share;
    const maxTtl = [share.maxTtlHours, a.quota.policy ? p.maxTtlHours : null].filter((x): x is number => typeof x === 'number');
    return {
      plan: a.plan,
      maxTtlHours: maxTtl.length ? Math.min(...maxTtl) : null,
      maxStoredBytes: share.maxStoredBytes,
      maxFileBytes: share.maxFileBytes,
      maxLinksPerDay: share.maxLinksPerDay,
      publicLinks: share.publicLinks && (!a.quota.policy || p.publicLinks),
      internalWithoutExpiry: share.internalWithoutExpiry,
      cloud: a.cloud,
    };
  }

  async usage(organizationId: string) {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [stored, today] = await Promise.all([
      this.repo.withTenant(organizationId, (tx) =>
        tx.fileShare.aggregate({
          where: { organizationId, revokedAt: null, purgedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          _sum: { bytes: true },
          _count: true,
        }),
      ),
      this.repo.withTenant(organizationId, (tx) => tx.fileShare.count({ where: { organizationId, createdAt: { gte: dayStart } } })),
    ]);
    return { storedBytes: stored._sum.bytes ?? 0, activeLinks: stored._count, linksToday: today };
  }

  async create(input: CreateShareInput) {
    const limits = await this.limits(input.organizationId);
    if (!limits) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'file_share_locked',
        message: 'File Share is not part of this plan. A workspace administrator can upgrade to share files as links.',
      });
    }
    const filename = safeFilename(input.filename);
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';
    if (limits.cloud && BLOCKED_EXT.has(ext)) {
      throw new BadRequestException(`Program files (${ext}) cannot be shared from AnythingMCP Cloud.`);
    }
    if (input.bytes.length === 0) throw new BadRequestException('The file is empty.');
    if (input.bytes.length > limits.maxFileBytes) {
      throw new BadRequestException(
        `The file is ${(input.bytes.length / MB).toFixed(1)} MB; this plan shares files up to ${(limits.maxFileBytes / MB).toFixed(0)} MB.`,
      );
    }
    const access = input.access === 'public' ? 'public' : 'internal';
    if (access === 'public' && !limits.publicLinks) {
      throw new ForbiddenException('Public links are switched off for this workspace. Create an internal link instead.');
    }
    const usage = await this.usage(input.organizationId);
    if (limits.maxLinksPerDay != null && usage.linksToday >= limits.maxLinksPerDay) {
      throw new ForbiddenException(`This plan allows ${limits.maxLinksPerDay} new links per day. Try again tomorrow or upgrade.`);
    }
    if (limits.maxStoredBytes != null && usage.storedBytes + input.bytes.length > limits.maxStoredBytes) {
      throw new ForbiddenException(
        `The files behind your active links would exceed ${(limits.maxStoredBytes / MB).toFixed(0)} MB. Revoke old links (Settings → File Share) or upgrade.`,
      );
    }

    let ttl = Number.isFinite(input.ttlHours) && (input.ttlHours as number) > 0 ? Math.floor(input.ttlHours as number) : 24;
    if (limits.maxTtlHours != null) ttl = Math.min(ttl, limits.maxTtlHours);
    const noExpiry = access === 'internal' && limits.internalWithoutExpiry && !input.ttlHours;
    const expiresAt = noExpiry ? null : new Date(Date.now() + ttl * 3600_000);

    const token = randomBytes(24).toString('base64url');
    const id = randomBytes(12).toString('hex');
    const storageKey = `orgs/${input.organizationId}/shares/${id}`;
    const mimeType = input.mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ? input.mimeType : mimeFor(filename);
    await this.storage.put(storageKey, input.bytes, mimeType);
    try {
      const row = await this.repo.withTenant(input.organizationId, (tx) =>
        tx.fileShare.create({
          data: {
            id,
            organizationId: input.organizationId,
            createdByUserId: input.userId ?? null,
            source: input.source,
            connectorId: input.connectorId ?? null,
            entryPath: input.entryPath ?? null,
            storageKey,
            filename,
            mimeType,
            bytes: input.bytes.length,
            sha256: sha256(input.bytes),
            access,
            tokenHash: sha256(token),
            expiresAt,
          },
        }),
      );
      return {
        id: row.id,
        url: `${this.frontendUrl()}/f/${token}`,
        filename,
        bytes: row.bytes,
        access,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      };
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('This link does not exist.');
    const row = await this.prisma.fileShare.findUnique({
      where: { tokenHash: sha256(token) },
      include: { organization: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('This link does not exist.');
    return row;
  }

  private state(row: { revokedAt: Date | null; purgedAt: Date | null; expiresAt: Date | null; maxDownloads: number | null; downloadCount: number }) {
    if (row.revokedAt) return 'revoked';
    if (row.purgedAt || (row.expiresAt && row.expiresAt <= new Date())) return 'expired';
    if (row.maxDownloads != null && row.downloadCount >= row.maxDownloads) return 'exhausted';
    return 'active';
  }

  /** The interstitial page's data. Never says more than file name, size, workspace and expiry. */
  async describe(token: string) {
    const row = await this.byToken(token);
    return {
      filename: row.filename,
      bytes: row.bytes,
      mimeType: row.mimeType,
      access: row.access,
      workspace: row.organization?.name ?? '',
      expiresAt: row.expiresAt?.toISOString() ?? null,
      state: this.state(row),
    };
  }

  /**
   * A 60-second download URL. Internal links need a signed-in member of the
   * link's workspace.
   */
  async issueDownload(token: string, user?: { sub: string; organizationId: string } | null) {
    const row = await this.byToken(token);
    const state = this.state(row);
    if (state !== 'active') throw new GoneException(state === 'revoked' ? 'This link was revoked.' : 'This link has expired.');
    if (row.access === 'internal') {
      if (!user) throw new ForbiddenException({ statusCode: 403, code: 'sign_in_required', message: 'Sign in to open this link.' });
      const member = await this.prisma.organizationMember.findFirst({ where: { organizationId: row.organizationId, userId: user.sub } });
      if (!member && user.organizationId !== row.organizationId) {
        throw new ForbiddenException('This link is for members of another workspace.');
      }
    }
    await this.prisma.fileShare.update({ where: { id: row.id }, data: { downloadCount: { increment: 1 } } });
    const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_URL_TTL_S;
    const payload = `${row.id}.${exp}`;
    const sig = createHmac('sha256', this.signingKey()).update(payload).digest('base64url');
    this.logger.log(`File Share download issued share=${row.id} org=${row.organizationId} access=${row.access}`);
    return { url: `${this.downloadBase()}/api/file-share/d/${payload}.${sig}`, expiresInSeconds: DOWNLOAD_URL_TTL_S };
  }

  /** Verifies a signed download URL and opens the stored file. */
  async openSigned(signed: string): Promise<{ stream: Readable; filename: string; mimeType: string; bytes: number }> {
    const m = signed.match(/^([a-f0-9]{24})\.(\d{10})\.([A-Za-z0-9_-]{20,})$/);
    if (!m) throw new NotFoundException('Invalid download link.');
    const [, id, expRaw, sig] = m;
    const expected = createHmac('sha256', this.signingKey()).update(`${id}.${expRaw}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new NotFoundException('Invalid download link.');
    if (Number(expRaw) < Math.floor(Date.now() / 1000)) throw new GoneException('This download link has expired. Open the share link again.');
    const row = await this.prisma.fileShare.findUnique({ where: { id } });
    if (!row || this.state({ ...row, downloadCount: 0 }) !== 'active') throw new GoneException('This link is no longer available.');
    const { stream } = await this.storage.open(row.storageKey);
    return { stream, filename: row.filename, mimeType: row.mimeType, bytes: row.bytes };
  }

  async list(organizationId: string, opts: { userId?: string; includeInactive?: boolean } = {}) {
    const now = new Date();
    const rows = await this.repo.withTenant(organizationId, (tx) =>
      tx.fileShare.findMany({
        where: {
          organizationId,
          ...(opts.userId ? { createdByUserId: opts.userId } : {}),
          ...(opts.includeInactive ? {} : { revokedAt: null, purgedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.createdByUserId).filter((x): x is string => !!x))] } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      bytes: r.bytes,
      access: r.access,
      source: r.source,
      entryPath: r.entryPath,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt?.toISOString() ?? null,
      downloadCount: r.downloadCount,
      state: this.state(r),
      createdBy: r.createdByUserId ? (byId.get(r.createdByUserId)?.name || byId.get(r.createdByUserId)?.email || null) : null,
    }));
  }

  async revoke(organizationId: string, id: string, actor: { sub: string; role: string }) {
    const row = await this.repo.withTenant(organizationId, (tx) => tx.fileShare.findFirst({ where: { id, organizationId } }));
    if (!row) throw new NotFoundException('Link not found.');
    if (actor.role !== 'ADMIN' && row.createdByUserId !== actor.sub) {
      throw new ForbiddenException('Only the person who created the link or an administrator can revoke it.');
    }
    await this.repo.withTenant(organizationId, (tx) => tx.fileShare.update({ where: { id }, data: { revokedAt: new Date() } }));
    await this.storage.delete(row.storageKey).catch((err) => this.logger.warn(`delete ${row.id}: ${(err as Error).message}`));
    await this.repo.withTenant(organizationId, (tx) => tx.fileShare.update({ where: { id }, data: { purgedAt: new Date() } }));
    return { ok: true };
  }

  /** Deletes the files of expired and revoked links (run by the worker every 10 minutes). */
  async sweep(limit = 200): Promise<number> {
    const now = new Date();
    const rows = await this.prisma.fileShare.findMany({
      where: { purgedAt: null, OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] },
      select: { id: true, storageKey: true },
      take: limit,
    });
    let n = 0;
    for (const r of rows) {
      try {
        await this.storage.delete(r.storageKey);
        await this.prisma.fileShare.update({ where: { id: r.id }, data: { purgedAt: now } });
        n++;
      } catch (err) {
        this.logger.warn(`sweep ${r.id}: ${(err as Error).message}`);
      }
    }
    return n;
  }
}
