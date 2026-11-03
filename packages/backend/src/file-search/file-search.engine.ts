import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { BINARY_MARKER, DEFAULT_MAX_BINARY_BYTES, type BinaryBody } from '../connectors/binary-response.util';
import { FileSearchQueryService, relPath, type FileScope } from './file-search-query.service';
import { FileSearchAccessService } from './file-search-access.service';
import { FilesWorkerClient } from './files-worker.client';
import { FileShareService, mimeFor } from './file-share.service';
import { isFileSearchMethod, type FileSearchMethod } from './file-search-builtins';
import { VIEWABLE_EXTENSIONS, extOf } from './file-search.types';

/**
 * Executes the `file_*` tools of a FILE_SEARCH connector (#1384). Reads the
 * index through FileSearchQueryService; the tools that need the file itself
 * (get_file, share_file, view_page) ask files-worker to read it, so this
 * process never connects to the customer's server.
 */

export interface FileToolContext {
  organizationId: string;
  connectorId: string;
  connectorName?: string;
  userId?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function int(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').slice(0, 20);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  return undefined;
}

@Injectable()
export class FileSearchEngine {
  private readonly logger = new Logger(FileSearchEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly query: FileSearchQueryService,
    private readonly access: FileSearchAccessService,
    private readonly worker: FilesWorkerClient,
    private readonly shares: FileShareService,
  ) {}

  /**
   * The caller's folder scope from Enterprise folder rules. A role without
   * rules sees everything, allow rules narrow a role to some folders, deny
   * rules always win, administrators and calls without a user (API keys) are
   * not narrowed. The query layer applies the scope in SQL.
   */
  async scopeFor(ctx: FileToolContext): Promise<FileScope> {
    const scope: FileScope = { organizationId: ctx.organizationId, connectorId: ctx.connectorId };
    if (!ctx.userId) return scope;
    const rules = await this.prisma.fileAccessRule.findMany({
      where: { organizationId: ctx.organizationId, connectorId: ctx.connectorId },
      select: { roleId: true, pattern: true, effect: true },
    });
    if (!rules.length) return scope;
    const a = await this.access.resolve(ctx.organizationId);
    if (!a.allowed || !a.quota.folderRules) return scope;
    const assignments = await this.prisma.userRoleAssignment.findMany({
      where: { userId: ctx.userId, OR: [{ organizationId: ctx.organizationId }, { organizationId: null }] },
      select: { roleId: true },
    });
    const mine = new Set(assignments.map((r) => r.roleId));
    // Folder rules (Enterprise), as the Files panel and the docs state them:
    //   - a role without rules sees everything;
    //   - allow rules limit the caller to those folders (any of their roles);
    //   - deny rules hide folders and always win;
    //   - workspace administrators see everything.
    const member = await this.prisma.organizationMember.findFirst({ where: { organizationId: ctx.organizationId, userId: ctx.userId }, select: { role: true } });
    if (member?.role === 'ADMIN') return scope;
    const applicable = rules.filter((r) => mine.has(r.roleId));
    if (!applicable.length) return scope;
    // One of the caller's roles has no rules (or no allow rules): that role
    // sees every folder, so allow rules of other roles do not narrow it.
    const allowRoles = new Set(rules.filter((r) => r.effect === 'allow').map((r) => r.roleId));
    const unrestricted = [...mine].some((id) => !allowRoles.has(id));
    const allow = unrestricted ? [] : applicable.filter((r) => r.effect === 'allow').map((r) => relPath(r.pattern)).filter(Boolean);
    const deny = applicable.filter((r) => r.effect === 'deny').map((r) => relPath(r.pattern)).filter(Boolean);
    return { ...scope, ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) };
  }

  async execute(method: string, params: Record<string, unknown>, ctx: FileToolContext): Promise<unknown> {
    if (!isFileSearchMethod(method)) throw new Error(`Unknown File Search method ${method}`);
    const a = await this.access.resolve(ctx.organizationId);
    if (!a.allowed) {
      return { error: 'file_search_locked', message: `${a.message} Ask a workspace administrator.` };
    }
    const scope = await this.scopeFor(ctx);
    return this.dispatch(method, params, ctx, scope);
  }

  private async dispatch(method: FileSearchMethod, p: Record<string, unknown>, ctx: FileToolContext, scope: FileScope): Promise<unknown> {
    switch (method) {
      case 'file_search':
        return this.query.search(scope, {
          query: str(p.query) ?? '',
          path: str(p.path),
          extensions: strArr(p.extensions),
          modifiedAfter: str(p.modified_after),
          modifiedBefore: str(p.modified_before),
          sort: p.sort === 'newest' ? 'newest' : 'relevance',
          limit: int(p.limit),
        });
      case 'file_find':
        // Without a name or glob every file would match: say what to pass instead.
        if (!str(p.name) && !str(p.glob) && p.sort !== 'newest') {
          return { error: 'Pass `name` (words of the file or folder name) or `glob` (e.g. "**/*.pdf"); for the newest files pass sort: "newest".' };
        }
        return this.query.find(scope, {
          name: str(p.name),
          glob: str(p.glob),
          path: str(p.path),
          extensions: strArr(p.extensions),
          modifiedAfter: str(p.modified_after),
          modifiedBefore: str(p.modified_before),
          sort: p.sort === 'newest' ? 'newest' : 'relevance',
          limit: int(p.limit),
        });
      case 'file_list':
        return this.query.list(scope, { path: str(p.path), limit: int(p.limit) });
      case 'file_read': {
        const path = str(p.path);
        if (!path) return { error: 'Pass the path of the file (from search, find or list).' };
        return this.query.read(scope, { path, pages: str(p.pages), offset: int(p.offset), maxChars: int(p.max_chars) });
      }
      case 'file_grep': {
        const pattern = str(p.pattern);
        if (!pattern) return { error: 'Pass a pattern.' };
        return this.query.grep(scope, {
          pattern,
          regex: p.regex === true,
          caseSensitive: p.case_sensitive === true,
          path: str(p.path),
          maxHits: int(p.max_hits),
        });
      }
      case 'file_status':
        return this.query.status(scope);
      case 'file_get':
        return this.getFile(str(p.path), ctx, scope);
      case 'file_view':
        return this.viewPage(str(p.path), p.page, ctx, scope);
      case 'file_share':
        return this.shareFile(str(p.path), p.access === 'public' ? 'public' : 'internal', int(p.ttl_hours), ctx, scope);
      case 'share_upload':
        return this.shareUpload(p, ctx);
      case 'share_list': {
        const { links, total } = await this.shares.list(ctx.organizationId, { userId: ctx.userId, pageSize: 50 });
        return { links, total, ...(total > links.length ? { note: `Showing the newest ${links.length} of ${total} links.` } : {}) };
      }
      case 'share_revoke': {
        const id = str(p.id);
        if (!id) return { error: 'Pass the id of the link (from share_list).' };
        if (!ctx.userId) return { error: 'Revoking needs a signed-in user.' };
        const member = await this.prisma.organizationMember.findFirst({ where: { organizationId: ctx.organizationId, userId: ctx.userId }, select: { role: true } });
        return this.shares.revoke(ctx.organizationId, id, { sub: ctx.userId, role: member?.role ?? 'VIEWER' });
      }
    }
  }

  private async shareUpload(p: Record<string, unknown>, ctx: FileToolContext): Promise<unknown> {
    const filename = str(p.filename);
    if (!filename) return { error: 'Pass a filename with its extension.' };
    let bytes: Buffer;
    if (typeof p.content_base64 === 'string' && p.content_base64) {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(p.content_base64)) return { error: 'content_base64 is not valid base64.' };
      bytes = Buffer.from(p.content_base64, 'base64');
    } else if (typeof p.content === 'string') {
      bytes = Buffer.from(p.content, 'utf8');
    } else {
      return { error: 'Pass content (text) or content_base64.' };
    }
    const link = await this.shares.create({
      organizationId: ctx.organizationId,
      userId: ctx.userId ?? null,
      source: 'upload',
      filename,
      bytes,
      access: p.access === 'public' ? 'public' : 'internal',
      ttlHours: int(p.ttl_hours),
    });
    return {
      link: link.url,
      id: link.id,
      filename: link.filename,
      bytes: link.bytes,
      access: link.access,
      expiresAt: link.expiresAt,
      note: 'Give the link to the user.',
    };
  }

  /** Checks the path is in the index and in the caller's scope, before the worker reads it. */
  private async entryInScope(path: string | undefined, scope: FileScope) {
    if (!path) return { error: 'Pass the path of the file (from search, find or list).' } as const;
    const entry = await this.query.entry(scope, path);
    if (!entry) return { error: `No file "${path}" in this folder. Use find or list to get the exact path.` } as const;
    return { entry } as const;
  }

  /**
   * The file itself. Many clients (Claude.ai among them) show an attached
   * image but not an attached PDF or spreadsheet, so with File Share on the
   * plan the user always gets a temporary internal link; images up to 4 MB are
   * attached as well. Without File Share small files are attached and the
   * model is told where the file lives in case the client cannot show it.
   */
  private async getFile(path: string | undefined, ctx: FileToolContext, scope: FileScope): Promise<unknown> {
    const r = await this.entryInScope(path, scope);
    if ('error' in r) return r;
    const a = await this.access.resolve(ctx.organizationId);
    const maxBytes = a.allowed ? a.quota.maxFileBytes : DEFAULT_MAX_BINARY_BYTES;
    const limits = await this.shares.limits(ctx.organizationId);
    const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(mimeFor(r.entry.path));

    if (limits) {
      const shared = (await this.shareFile(r.entry.path, 'internal', 24, ctx, scope, maxBytes)) as Record<string, unknown>;
      if (!isImage || shared.error || r.entry.size > DEFAULT_MAX_BINARY_BYTES) return shared;
      const file = await this.worker.fetchFile(ctx.organizationId, ctx.connectorId, r.entry.path, DEFAULT_MAX_BINARY_BYTES);
      return this.binary(file, { link: shared.link, expiresAt: shared.expiresAt, linkNote: shared.note });
    }
    if (r.entry.size <= DEFAULT_MAX_BINARY_BYTES) {
      const file = await this.worker.fetchFile(ctx.organizationId, ctx.connectorId, r.entry.path, DEFAULT_MAX_BINARY_BYTES);
      return this.binary(file, {
        path: r.entry.path,
        hint: 'If the user cannot see the attachment, tell them the path so they can open the file on the file server.',
      });
    }
    return {
      path: r.entry.path,
      size: r.entry.size,
      note: 'The file is too large to attach, and this plan has no File Share links. Tell the user where the file is (the path) so they can open it on the file server.',
    };
  }

  /**
   * One page of a PDF, or an image, as a JPEG picture: clients such as
   * Claude.ai show image content but not an embedded PDF, and the title block
   * of a drawing is vector graphics with no text to read.
   */
  private async viewPage(path: string | undefined, rawPage: unknown, ctx: FileToolContext, scope: FileScope): Promise<unknown> {
    const page = rawPage === undefined || rawPage === null || rawPage === '' ? 1 : int(rawPage);
    if (page === undefined || page < 1) return { error: 'Pass page as a number from 1.' };
    const r = await this.entryInScope(path, scope);
    if ('error' in r) return r;
    const ext = extOf(r.entry.path);
    if (!VIEWABLE_EXTENSIONS.has(ext)) {
      return {
        error: 'unsupported',
        message: `Only PDF and image files (${[...VIEWABLE_EXTENSIONS].join(', ')}) can be shown as a picture. Use the read tool for the text of this file.`,
      };
    }
    const a = await this.access.resolve(ctx.organizationId);
    const maxBytes = a.allowed ? a.quota.maxFileBytes : DEFAULT_MAX_BINARY_BYTES;
    if (r.entry.size > maxBytes) {
      return { error: 'too_large', message: `The file is ${(r.entry.size / 1048576).toFixed(1)} MB; this plan reads files up to ${(maxBytes / 1048576).toFixed(0)} MB.` };
    }
    const shown = await this.worker.render(ctx.organizationId, ctx.connectorId, r.entry.path, { page, maxBytes });
    if (!shown.ok || !shown.base64) {
      const kind = shown.error?.kind ?? 'damaged';
      return {
        error: kind,
        message: shown.error?.message ?? 'The page could not be shown.',
        path: r.entry.path,
        ...(kind === 'page_out_of_range' ? { hint: 'Ask for a page within the page count named in the message.' } : {}),
      };
    }
    const pageCount = shown.pageCount ?? 1;
    const shownPage = shown.page ?? page;
    const base = r.entry.path.split('/').pop()!.replace(/\.[^.]+$/, '');
    return {
      [BINARY_MARKER]: 1,
      contentType: 'image/jpeg',
      bytes: Buffer.byteLength(shown.base64, 'base64'),
      filename: `${base}-page-${shownPage}.jpg`,
      base64: shown.base64,
      extra: {
        path: r.entry.path,
        page: shownPage,
        pageCount,
        width: shown.width,
        height: shown.height,
        note: shownPage < pageCount ? `Use page ${shownPage + 1} for the next page.` : 'This is the last page.',
      },
    } satisfies BinaryBody;
  }

  private binary(file: { contentType: string; size: number; filename: string; bytes: Buffer }, extra: Record<string, unknown>): BinaryBody {
    return {
      [BINARY_MARKER]: 1,
      contentType: file.contentType !== 'application/octet-stream' ? file.contentType : mimeFor(file.filename),
      bytes: file.size,
      filename: file.filename,
      base64: file.bytes.toString('base64'),
      extra,
    };
  }

  private async shareFile(
    path: string | undefined,
    access: 'internal' | 'public',
    ttlHours: number | undefined,
    ctx: FileToolContext,
    scope: FileScope,
    maxBytes?: number,
  ): Promise<unknown> {
    const r = await this.entryInScope(path, scope);
    if ('error' in r) return r;
    const limits = await this.shares.limits(ctx.organizationId);
    if (!limits) return { error: 'file_share_locked', message: 'This plan has no File Share links. A workspace administrator can upgrade.' };
    const cap = Math.min(limits.maxFileBytes, maxBytes ?? limits.maxFileBytes);
    if (r.entry.size > cap) {
      return { error: 'too_large', message: `The file is ${(r.entry.size / 1048576).toFixed(1)} MB; links on this plan carry files up to ${(cap / 1048576).toFixed(0)} MB.` };
    }
    const file = await this.worker.fetchFile(ctx.organizationId, ctx.connectorId, r.entry.path, cap);
    const link = await this.shares.create({
      organizationId: ctx.organizationId,
      userId: ctx.userId ?? null,
      source: 'connector',
      connectorId: ctx.connectorId,
      entryPath: r.entry.path,
      filename: file.filename,
      mimeType: file.contentType !== 'application/octet-stream' ? file.contentType : undefined,
      bytes: file.bytes,
      access,
      ttlHours,
    });
    this.logger.log(`share_file org=${ctx.organizationId} connector=${ctx.connectorId} access=${access}`);
    return {
      link: link.url,
      filename: link.filename,
      access: link.access,
      expiresAt: link.expiresAt,
      note:
        access === 'internal'
          ? 'Give the link to the user. It opens for signed-in members of this workspace.'
          : 'Give the link to the user. Anyone with the link can download the file until it expires.',
    };
  }
}
