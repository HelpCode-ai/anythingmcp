import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { EditionService } from '../ee/licensing/edition.service';
import {
  folderVisibility,
  resolveFolder,
  subtreeIds,
  type FolderAccess,
} from '../knowledge-folders/knowledge-folders.service';

export const MEMORY_ACCESS_LEVELS = ['inherit', 'none', 'read', 'personal', 'contribute'] as const;
export type MemoryAccessSetting = (typeof MEMORY_ACCESS_LEVELS)[number];
export type MemoryAccess = Exclude<MemoryAccessSetting, 'inherit'>;

export const MEMORY_SCOPES = ['personal', 'organization'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = ['fact', 'preference', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_WRITE_MODES = ['approval', 'auto'] as const;
export type MemoryWriteMode = (typeof MEMORY_WRITE_MODES)[number];

export const MEMORY_CONTENT_MAX = 2_000;
export const MEMORY_TAGS_MAX = 10;
const MEMORY_TAG_LENGTH = 40;
/** Personal items one member may keep in one workspace. */
export const MEMORY_PERSONAL_MAX = 1_000;
/** Items (any scope) one workspace may keep. */
export const MEMORY_ORG_MAX = 20_000;
const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 50;

const DEFAULT_ACCESS_KEY = 'memory_default_access';
const WRITE_MODE_KEY = 'memory_org_write_mode';
const DEFAULT_ACCESS: MemoryAccess = 'personal';
const DEFAULT_WRITE_MODE: MemoryWriteMode = 'approval';

const RANK: Record<MemoryAccess, number> = { none: 0, read: 1, personal: 2, contribute: 3 };

/** Whether an access level allows at least `needed`. */
export function allows(level: MemoryAccess, needed: MemoryAccess): boolean {
  return RANK[level] >= RANK[needed];
}

/**
 * Text that looks like a credential. Memory is read back into AI clients and
 * shown in the dashboard, so secrets must never be stored in it.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bmcp_[0-9a-f]{40,}/,
  /\b(?:password|passwort|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|token)\s*[:=]\s*\S{6,}/i,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export interface MemoryCaller {
  organizationId: string;
  userId: string;
  level: MemoryAccess;
  /** Knowledge folders the caller may see; company items elsewhere are hidden. */
  folders?: FolderAccess | null;
}

export interface MemoryActionContext {
  actorUserId: string;
  ip?: string;
  userAgent?: string;
}

export interface MemorySource {
  via: 'mcp' | 'ui';
  mcpServerId?: string;
  client?: string;
}

const ITEM_SELECT = {
  id: true,
  scope: true,
  kind: true,
  content: true,
  tags: true,
  status: true,
  source: true,
  ownerUserId: true,
  createdByUserId: true,
  approvedByUserId: true,
  approvedAt: true,
  folderId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Workspace memory: facts, preferences and notes that AI clients save and find
 * again, for one member (personal) or for the whole organization.
 *
 * Available with an Enterprise licence (EditionService.hasMemory). Personal
 * items are readable only by their owner; organization items written by an AI
 * client wait for approval unless the workspace chose automatic. Every query
 * is filtered by organization.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly edition: EditionService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  // ── Entitlement, access and settings ────────────────────────────────────

  licensed(organizationId: string): Promise<boolean> {
    return this.edition.hasMemory(organizationId);
  }

  assertLicensed(organizationId: string): Promise<void> {
    return this.edition.assertMemory(organizationId);
  }

  async settings(
    organizationId: string,
  ): Promise<{ defaultAccess: MemoryAccess; writeMode: MemoryWriteMode }> {
    const rows = await this.prisma.orgSettings.findMany({
      where: { organizationId, key: { in: [DEFAULT_ACCESS_KEY, WRITE_MODE_KEY] } },
      select: { key: true, value: true },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    const access = get(DEFAULT_ACCESS_KEY);
    const mode = get(WRITE_MODE_KEY);
    return {
      defaultAccess:
        access && access !== 'inherit' && (MEMORY_ACCESS_LEVELS as readonly string[]).includes(access)
          ? (access as MemoryAccess)
          : DEFAULT_ACCESS,
      writeMode: (MEMORY_WRITE_MODES as readonly string[]).includes(mode ?? '')
        ? (mode as MemoryWriteMode)
        : DEFAULT_WRITE_MODE,
    };
  }

  async updateSettings(
    organizationId: string,
    patch: { defaultAccess?: MemoryAccess; writeMode?: MemoryWriteMode },
    ctx: MemoryActionContext,
  ) {
    await this.edition.assertMemory(organizationId);
    const before = await this.settings(organizationId);
    const writes: Array<[string, string]> = [];
    if (patch.defaultAccess && patch.defaultAccess !== before.defaultAccess) {
      writes.push([DEFAULT_ACCESS_KEY, patch.defaultAccess]);
    }
    if (patch.writeMode && patch.writeMode !== before.writeMode) {
      writes.push([WRITE_MODE_KEY, patch.writeMode]);
    }
    for (const [key, value] of writes) {
      await this.prisma.orgSettings.upsert({
        where: { organizationId_key: { organizationId, key } },
        create: { organizationId, key, value },
        update: { value },
      });
    }
    const after = await this.settings(organizationId);
    if (writes.length > 0) {
      await this.securityEvents.log({
        event: SecurityEvents.MEMORY_SETTINGS_CHANGED,
        actorType: 'USER',
        organizationId,
        actorUserId: ctx.actorUserId,
        metadata: { from: before, to: after },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
    return after;
  }

  /**
   * What this member may do with memory in this workspace. `none` for a
   * non-member, a deactivated member, a caller without a user, or a workspace
   * without the licence. Fails closed.
   */
  async accessFor(organizationId: string, userId?: string | null): Promise<MemoryAccess> {
    if (!organizationId || !userId) return 'none';
    if (!(await this.licensed(organizationId))) return 'none';
    const member = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { memoryAccess: true, deactivatedAt: true },
    });
    if (!member || member.deactivatedAt) return 'none';
    if (member.memoryAccess !== 'inherit' && member.memoryAccess in RANK) {
      return member.memoryAccess as MemoryAccess;
    }
    return (await this.settings(organizationId)).defaultAccess;
  }

  async caller(organizationId: string, userId?: string | null): Promise<MemoryCaller | null> {
    const level = await this.accessFor(organizationId, userId);
    return level === 'none' ? null : { organizationId, userId: userId!, level };
  }

  /** Admin: set the access of members of this workspace (others are ignored). */
  async setAccess(
    organizationId: string,
    userIds: string[],
    access: MemoryAccessSetting,
    ctx: MemoryActionContext,
  ): Promise<{ updated: number; notFound: string[] }> {
    await this.edition.assertMemory(organizationId);
    const ids = [...new Set(userIds)].slice(0, 500);
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, userId: { in: ids } },
      select: { userId: true, memoryAccess: true },
    });
    const found = new Set(members.map((m) => m.userId));
    const changed = members.filter((m) => m.memoryAccess !== access);
    if (changed.length > 0) {
      await this.prisma.organizationMember.updateMany({
        where: { organizationId, userId: { in: changed.map((m) => m.userId) } },
        data: { memoryAccess: access },
      });
    }
    for (const m of changed) {
      await this.securityEvents.log({
        event: SecurityEvents.MEMORY_ACCESS_CHANGED,
        actorType: 'USER',
        organizationId,
        actorUserId: ctx.actorUserId,
        targetUserId: m.userId,
        metadata: { from: m.memoryAccess, to: access },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
    return { updated: changed.length, notFound: ids.filter((id) => !found.has(id)) };
  }

  // ── Read ────────────────────────────────────────────────────────────────

  /**
   * Full-text search over the active organization memory and, from
   * `personal` up, the caller's own personal items. An empty query returns
   * the most recent ones. Falls back to a substring match when the words
   * match nothing (partial words, codes).
   */
  async search(
    caller: MemoryCaller,
    opts: { query?: string; scope?: MemoryScope; limit?: number; folder?: string },
  ) {
    const limit = Math.min(Math.max(opts.limit ?? SEARCH_DEFAULT, 1), SEARCH_MAX);
    // A folder narrows to company items in it and its subfolders; personal
    // memory has no folders.
    let filterIds: string[] | null = null;
    if (opts.folder?.trim()) {
      const tree = caller.folders?.folders ?? [];
      const f = resolveFolder(tree, opts.folder);
      if (!f) return [];
      filterIds = [...subtreeIds(tree, f.id)];
    }
    const includePersonal = allows(caller.level, 'personal') && !filterIds;
    if (opts.scope === 'personal' && !includePersonal) return [];
    const q = (opts.query ?? '').trim().slice(0, 300);
    const restricted = !!caller.folders && !caller.folders.all;
    const orgClause = filterIds
      ? { scope: 'organization', folderId: { in: filterIds } }
      : restricted
        ? { scope: 'organization', AND: [folderVisibility(caller.folders)] }
        : { scope: 'organization' };
    const visible = {
      organizationId: caller.organizationId,
      status: 'active',
      OR: [
        ...(opts.scope !== 'personal' ? [orgClause] : []),
        ...(includePersonal && opts.scope !== 'organization'
          ? [{ scope: 'personal', ownerUserId: caller.userId }]
          : []),
      ],
    };

    if (q) {
      const scope = opts.scope ?? null;
      const visibleIds = [...(caller.folders?.ids ?? [])];
      const hits = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT m.id
        FROM memory_items m, websearch_to_tsquery('simple', ${q}) AS q
        WHERE m.organization_id = ${caller.organizationId}
          AND m.status = 'active'
          AND (${scope}::text IS NULL OR m.scope = ${scope}::text)
          AND (
            m.scope = 'organization'
            OR (${includePersonal} AND m.scope = 'personal' AND m.owner_user_id = ${caller.userId})
          )
          AND (
            m.scope = 'personal'
            OR NOT ${restricted}
            OR m.folder_id IS NULL
            OR m.folder_id = ANY(${visibleIds}::text[])
          )
          AND (${filterIds}::text[] IS NULL OR m.folder_id = ANY(${filterIds}::text[]))
          AND m.search_vector @@ q
        ORDER BY ts_rank(m.search_vector, q) DESC, m.updated_at DESC
        LIMIT ${limit}`;
      if (hits.length > 0) {
        const rows = await this.prisma.memoryItem.findMany({
          where: { ...visible, id: { in: hits.map((h) => h.id) } },
          select: ITEM_SELECT,
        });
        const order = new Map(hits.map((h, i) => [h.id, i]));
        return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      }
      return this.prisma.memoryItem.findMany({
        where: { ...visible, content: { contains: q, mode: 'insensitive' } },
        select: ITEM_SELECT,
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });
    }
    return this.prisma.memoryItem.findMany({
      where: visible,
      select: ITEM_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
  }

  /** Dashboard list: the caller's personal items, or the organization's by status. */
  async list(
    organizationId: string,
    userId: string,
    opts: {
      scope: MemoryScope;
      status?: string;
      q?: string;
      take?: number;
      skip?: number;
      /** Company memory: a folder id (with subfolders) or 'none' for unfiled items. */
      folderId?: string;
      folders?: FolderAccess | null;
    },
  ) {
    await this.edition.assertMemory(organizationId);
    const where: any =
      opts.scope === 'personal'
        ? { organizationId, scope: 'personal', ownerUserId: userId }
        : {
            organizationId,
            scope: 'organization',
            status: ['active', 'pending', 'rejected'].includes(opts.status ?? '')
              ? opts.status
              : 'active',
          };
    if (opts.scope === 'organization') {
      where.AND = [folderVisibility(opts.folders)];
      if (opts.folderId === 'none') where.folderId = null;
      else if (opts.folderId) {
        const tree = opts.folders?.folders ?? [];
        where.folderId = tree.some((f) => f.id === opts.folderId)
          ? { in: [...subtreeIds(tree, opts.folderId)] }
          : '__none__';
      }
    }
    if (opts.q?.trim()) where.content = { contains: opts.q.trim(), mode: 'insensitive' };
    const take = Math.min(Math.max(opts.take ?? 25, 1), 100);
    const skip = Math.max(opts.skip ?? 0, 0);
    const [items, total, pending] = await Promise.all([
      this.prisma.memoryItem.findMany({
        where,
        select: ITEM_SELECT,
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.memoryItem.count({ where }),
      this.prisma.memoryItem.count({
        where: {
          organizationId,
          scope: 'organization',
          status: 'pending',
          AND: [folderVisibility(opts.folders)],
        },
      }),
    ]);
    return { items, total, pending, take, skip };
  }

  // ── Write ───────────────────────────────────────────────────────────────

  /**
   * Save an item. Personal needs `personal`; organization needs `contribute`
   * from an AI client (pending unless the workspace chose automatic) or an
   * admin/editor in the dashboard (`asCurator`, active right away).
   */
  async save(
    caller: MemoryCaller,
    input: { content: string; kind?: string; scope?: string; tags?: unknown; folder?: string | null },
    source: MemorySource,
    opts?: { asCurator?: boolean },
  ) {
    const scope: MemoryScope = input.scope === 'organization' ? 'organization' : 'personal';
    if (scope === 'personal' && !allows(caller.level, 'personal')) {
      throw new ForbiddenException('Your memory access does not include personal memory.');
    }
    if (scope === 'organization' && !opts?.asCurator && !allows(caller.level, 'contribute')) {
      throw new ForbiddenException('Your memory access does not include saving to the company memory.');
    }
    const content = this.cleanContent(input.content);
    const kind = (MEMORY_KINDS as readonly string[]).includes(input.kind ?? '')
      ? (input.kind as MemoryKind)
      : 'fact';
    const tags = cleanTags(input.tags);
    // Only company items are filed, and only in a folder the caller can see.
    let folderId: string | null = null;
    if (scope === 'organization' && input.folder) {
      const f = resolveFolder(caller.folders?.folders ?? [], input.folder);
      if (!f) throw new BadRequestException(`No folder "${input.folder}".`);
      folderId = f.id;
    }

    const [orgCount, personalCount] = await Promise.all([
      this.prisma.memoryItem.count({ where: { organizationId: caller.organizationId } }),
      scope === 'personal'
        ? this.prisma.memoryItem.count({
            where: {
              organizationId: caller.organizationId,
              scope: 'personal',
              ownerUserId: caller.userId,
            },
          })
        : Promise.resolve(0),
    ]);
    if (orgCount >= MEMORY_ORG_MAX) {
      throw new BadRequestException(`This workspace has reached ${MEMORY_ORG_MAX} memory items.`);
    }
    if (personalCount >= MEMORY_PERSONAL_MAX) {
      throw new BadRequestException(
        `You have reached ${MEMORY_PERSONAL_MAX} personal memory items in this workspace. Remove some first.`,
      );
    }

    let status = 'active';
    if (scope === 'organization' && !opts?.asCurator) {
      status = (await this.settings(caller.organizationId)).writeMode === 'auto' ? 'active' : 'pending';
    }
    const now = new Date();
    return this.prisma.memoryItem.create({
      data: {
        organizationId: caller.organizationId,
        scope,
        ownerUserId: scope === 'personal' ? caller.userId : null,
        folderId,
        kind,
        content,
        tags,
        status,
        source: source as any,
        createdByUserId: caller.userId,
        ...(scope === 'organization' && status === 'active'
          ? { approvedByUserId: opts?.asCurator ? caller.userId : null, approvedAt: now }
          : {}),
      },
      select: ITEM_SELECT,
    });
  }

  /** memory_forget: only the caller's own personal items. */
  async forget(caller: MemoryCaller, id: string): Promise<boolean> {
    if (!allows(caller.level, 'personal')) return false;
    const res = await this.prisma.memoryItem.deleteMany({
      where: {
        id,
        organizationId: caller.organizationId,
        scope: 'personal',
        ownerUserId: caller.userId,
      },
    });
    return res.count > 0;
  }

  /**
   * Dashboard edit/delete. A personal item only by its owner; an organization
   * item only by a curator (admin or editor).
   */
  async update(
    organizationId: string,
    userId: string,
    isCurator: boolean,
    id: string,
    patch: { content?: string; kind?: string; tags?: unknown },
    folders?: FolderAccess | null,
  ) {
    await this.edition.assertMemory(organizationId);
    await this.editable(organizationId, userId, isCurator, id, folders);
    const data: Record<string, unknown> = {};
    if (typeof patch.content === 'string') data.content = this.cleanContent(patch.content);
    if (patch.kind && (MEMORY_KINDS as readonly string[]).includes(patch.kind)) data.kind = patch.kind;
    if (patch.tags !== undefined) data.tags = cleanTags(patch.tags);
    return this.prisma.memoryItem.update({ where: { id }, data, select: ITEM_SELECT });
  }

  async remove(
    organizationId: string,
    userId: string,
    isCurator: boolean,
    id: string,
    folders?: FolderAccess | null,
  ) {
    await this.edition.assertMemory(organizationId);
    await this.editable(organizationId, userId, isCurator, id, folders);
    await this.prisma.memoryItem.delete({ where: { id } });
    return { ok: true };
  }

  /** Curator: approve or reject a pending organization item. */
  async review(
    organizationId: string,
    userId: string,
    id: string,
    decision: 'approve' | 'reject',
    folders?: FolderAccess | null,
  ) {
    await this.edition.assertMemory(organizationId);
    const item = await this.prisma.memoryItem.findFirst({
      where: { id, organizationId, scope: 'organization', AND: [folderVisibility(folders)] },
      select: { id: true },
    });
    if (!item) throw new NotFoundException('Memory item not found.');
    return this.prisma.memoryItem.update({
      where: { id },
      data:
        decision === 'approve'
          ? { status: 'active', approvedByUserId: userId, approvedAt: new Date() }
          : { status: 'rejected', approvedByUserId: userId, approvedAt: new Date() },
      select: ITEM_SELECT,
    });
  }

  /**
   * Admin: erase a member's personal memory in this workspace without reading
   * it (data protection requests). Works without the licence, so data can
   * always be removed.
   */
  async erasePersonal(organizationId: string, targetUserId: string, ctx: MemoryActionContext) {
    const res = await this.prisma.memoryItem.deleteMany({
      where: { organizationId, scope: 'personal', ownerUserId: targetUserId },
    });
    await this.securityEvents.log({
      event: SecurityEvents.MEMORY_ERASED,
      actorType: 'USER',
      organizationId,
      actorUserId: ctx.actorUserId,
      targetUserId,
      metadata: { scope: 'personal', count: res.count },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { erased: res.count };
  }

  private async editable(
    organizationId: string,
    userId: string,
    isCurator: boolean,
    id: string,
    folders?: FolderAccess | null,
  ) {
    const item = await this.prisma.memoryItem.findFirst({
      where: { id, organizationId },
      select: { scope: true, ownerUserId: true, folderId: true },
    });
    const folderOk =
      !item?.folderId || !folders || folders.all || folders.ids.has(item.folderId);
    const ok =
      !!item &&
      (item.scope === 'personal' ? item.ownerUserId === userId : isCurator && folderOk);
    // Someone else's personal item answers like one that does not exist.
    if (!ok) throw new NotFoundException('Memory item not found.');
  }

  private cleanContent(raw: unknown): string {
    const content = typeof raw === 'string' ? raw.trim() : '';
    if (!content) throw new BadRequestException('Memory content is empty.');
    if (content.length > MEMORY_CONTENT_MAX) {
      throw new BadRequestException(`Memory content is limited to ${MEMORY_CONTENT_MAX} characters.`);
    }
    if (looksLikeSecret(content)) {
      throw new BadRequestException(
        'This looks like a password, token or key. Secrets are never stored in memory.',
      );
    }
    return content;
  }
}

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().toLowerCase().slice(0, MEMORY_TAG_LENGTH);
    if (tag) out.add(tag);
    if (out.size >= MEMORY_TAGS_MAX) break;
  }
  return [...out];
}
