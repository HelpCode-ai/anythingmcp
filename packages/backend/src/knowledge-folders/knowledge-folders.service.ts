import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { EditionService } from '../ee/licensing/edition.service';

/** Deepest folder level (1 = top level). */
export const FOLDER_MAX_DEPTH = 4;
const FOLDER_NAME_MAX = 80;
const FOLDER_DESCRIPTION_MAX = 500;
/** Separator used to show and to resolve folder paths ("Sales / Quotes"). */
export const PATH_SEPARATOR = ' / ';

export interface FolderNode {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  roleIds: string[];
  /** Full path from the top, e.g. "Sales / Quotes". */
  path: string;
  /** 1 for a top-level folder. */
  depth: number;
}

/**
 * Which folders one caller may see in one workspace. `all` is true when no
 * restriction applies to them (no restricted folder, or a workspace admin);
 * otherwise `ids` lists the visible folders. Items without a folder are
 * always visible.
 */
export interface FolderAccess {
  organizationId: string;
  all: boolean;
  ids: Set<string>;
  /** The folders this caller may see, with their paths. */
  folders: FolderNode[];
}

export interface FolderActionContext {
  actorUserId: string;
  ip?: string;
  userAgent?: string;
}

/** Prisma `where` fragment keeping only items in folders the caller may see. */
export function folderVisibility(access?: FolderAccess | null): Record<string, unknown> {
  if (!access || access.all) return {};
  return { OR: [{ folderId: null }, { folderId: { in: [...access.ids] } }] };
}

/** Builds paths and depths for a flat list of folder rows. */
export function buildTree(
  rows: Array<{ id: string; parentId: string | null; name: string; description: string | null; roleIds: unknown }>,
): FolderNode[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: FolderNode[] = [];
  for (const r of rows) {
    const names: string[] = [];
    let cur: typeof r | undefined = r;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    out.push({
      id: r.id,
      parentId: r.parentId,
      name: r.name,
      description: r.description,
      roleIds: Array.isArray(r.roleIds) ? (r.roleIds as string[]) : [],
      path: names.join(PATH_SEPARATOR),
      depth: names.length,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The folder and every folder below it. */
export function subtreeIds(folders: FolderNode[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * The role limits that apply at a place in the tree: one entry per limited
 * folder from `folderId` up to the top (a caller must satisfy each). Empty
 * for the top level or an unlimited branch.
 */
export function restrictionChain(folders: FolderNode[], folderId: string | null): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: string[] = [];
  let cur = folderId ? byId.get(folderId) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.roleIds.length) chain.push([...cur.roleIds].sort().join(','));
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/** Whether moving from one place to another drops a role limit (widens access). */
export function widensAccess(folders: FolderNode[], from: string | null, to: string | null): boolean {
  const target = new Set(restrictionChain(folders, to));
  return restrictionChain(folders, from).some((limit) => !target.has(limit));
}

const WIDEN_MESSAGE =
  'This would take content out of a folder limited to roles and show it to more people. Only an admin can do that.';

/** A folder by id or by path ("Sales / Quotes", "sales/quotes"), among `folders`. */
export function resolveFolder(folders: FolderNode[], ref: string): FolderNode | null {
  const key = (ref ?? '').trim();
  if (!key) return null;
  const byId = folders.find((f) => f.id === key);
  if (byId) return byId;
  const norm = (p: string) =>
    p
      .split('/')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .join('/');
  const wanted = norm(key);
  return folders.find((f) => norm(f.path) === wanted) ?? null;
}

/**
 * The workspace's knowledge tree: one set of folders shared by skills and the
 * company memory. Folders themselves are for every edition; limiting a folder
 * to roles (team scope) needs Enterprise, while limits already set keep
 * applying without it, so access never widens on its own.
 */
@Injectable()
export class KnowledgeFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly edition: EditionService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async tree(organizationId: string): Promise<FolderNode[]> {
    const rows = await this.prisma.knowledgeFolder.findMany({
      where: { organizationId },
      select: { id: true, parentId: true, name: true, description: true, roleIds: true },
    });
    return buildTree(rows);
  }

  /**
   * What one caller may see. A folder is visible when it and each of its
   * ancestors is either unrestricted or limited to a role the caller holds in
   * this workspace (or a role granted everywhere). Workspace admins see
   * everything. No user, a non-member or a deactivated member sees only
   * unrestricted folders. Fails closed.
   */
  async accessFor(organizationId: string, userId?: string | null): Promise<FolderAccess> {
    const folders = await this.tree(organizationId);
    const all = (): FolderAccess => ({
      organizationId,
      all: true,
      ids: new Set(folders.map((f) => f.id)),
      folders,
    });
    if (!folders.some((f) => f.roleIds.length > 0)) return all();

    let roleIds = new Set<string>();
    if (userId) {
      const member = await this.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
        select: { role: true, deactivatedAt: true },
      });
      if (member && !member.deactivatedAt) {
        if (member.role === 'ADMIN') return all();
        const assignments = await this.prisma.userRoleAssignment.findMany({
          where: { userId, OR: [{ organizationId }, { organizationId: null }] },
          select: { roleId: true },
        });
        roleIds = new Set(assignments.map((a) => a.roleId));
      }
    }

    const byId = new Map(folders.map((f) => [f.id, f]));
    const visible = new Set<string>();
    for (const f of folders) {
      let ok = true;
      let cur: FolderNode | undefined = f;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (cur.roleIds.length > 0 && !cur.roleIds.some((r) => roleIds.has(r))) {
          ok = false;
          break;
        }
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      if (ok) visible.add(f.id);
    }
    return {
      organizationId,
      all: false,
      ids: visible,
      folders: folders.filter((f) => visible.has(f.id)),
    };
  }

  /** Dashboard tree with item counts, limited to what the caller may see. */
  async listForCaller(organizationId: string, userId: string) {
    const access = await this.accessFor(organizationId, userId);
    const ids = access.folders.map((f) => f.id);
    const [skills, memory, enterprise] = await Promise.all([
      ids.length
        ? this.prisma.kgSkillSuggestion.groupBy({
            by: ['folderId'],
            where: { organizationId, folderId: { in: ids } },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{ folderId: string | null; _count: { _all: number } }>),
      ids.length
        ? this.prisma.memoryItem.groupBy({
            by: ['folderId'],
            where: { organizationId, scope: 'organization', folderId: { in: ids } },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{ folderId: string | null; _count: { _all: number } }>),
      this.edition.hasEnterprise(organizationId),
    ]);
    const count = (rows: Array<{ folderId: string | null; _count: { _all: number } }>, id: string) =>
      rows.find((r) => r.folderId === id)?._count._all ?? 0;
    return {
      folders: access.folders.map((f) => ({
        ...f,
        skillCount: count(skills, f.id),
        memoryCount: count(memory, f.id),
      })),
      // Whether role limits can be edited here.
      restrictionsAvailable: enterprise,
    };
  }

  async create(
    organizationId: string,
    input: { name: string; parentId?: string | null; description?: string | null },
  ) {
    const name = cleanName(input.name);
    const folders = await this.tree(organizationId);
    const parent = input.parentId ? this.mustFind(folders, input.parentId) : null;
    if ((parent?.depth ?? 0) + 1 > FOLDER_MAX_DEPTH) {
      throw new BadRequestException(`Folders go at most ${FOLDER_MAX_DEPTH} levels deep.`);
    }
    this.assertFreeName(folders, parent?.id ?? null, name);
    const row = await this.prisma.knowledgeFolder.create({
      data: {
        organizationId,
        parentId: parent?.id ?? null,
        name,
        description: cleanDescription(input.description),
      },
    });
    return (await this.tree(organizationId)).find((f) => f.id === row.id)!;
  }

  /** Rename, describe or move (`parentId: null` = top level). */
  async update(
    organizationId: string,
    id: string,
    patch: { name?: string; description?: string | null; parentId?: string | null },
    actorIsAdmin = false,
  ) {
    const folders = await this.tree(organizationId);
    const folder = this.mustFind(folders, id);
    const data: Record<string, unknown> = {};
    let parentId = folder.parentId;
    if (patch.parentId !== undefined) {
      parentId = patch.parentId || null;
      // Moving a folder out from under a limited one would drop that limit
      // for everything inside it.
      if (!actorIsAdmin && widensAccess(folders, folder.parentId, parentId)) {
        throw new ForbiddenException(WIDEN_MESSAGE);
      }
      if (parentId) {
        const below = subtreeIds(folders, folder.id);
        if (below.has(parentId)) throw new BadRequestException('A folder cannot move into itself.');
        const parent = this.mustFind(folders, parentId);
        const height = Math.max(...[...below].map((fid) => folders.find((f) => f.id === fid)!.depth)) - folder.depth + 1;
        if (parent.depth + height > FOLDER_MAX_DEPTH) {
          throw new BadRequestException(`Folders go at most ${FOLDER_MAX_DEPTH} levels deep.`);
        }
      }
      data.parentId = parentId;
    }
    const name = patch.name !== undefined ? cleanName(patch.name) : folder.name;
    if (patch.name !== undefined) data.name = name;
    if (patch.name !== undefined || patch.parentId !== undefined) {
      this.assertFreeName(folders, parentId, name, folder.id);
    }
    if (patch.description !== undefined) data.description = cleanDescription(patch.description);
    await this.prisma.knowledgeFolder.update({ where: { id }, data });
    return (await this.tree(organizationId)).find((f) => f.id === id)!;
  }

  /**
   * Delete a folder. Its subfolders and items move to its parent (or the top
   * level); nothing else is deleted. A subfolder whose name is taken there is
   * renamed with a suffix.
   */
  async remove(organizationId: string, id: string) {
    const folders = await this.tree(organizationId);
    const folder = this.mustFind(folders, id);
    const parentId = folder.parentId;
    const limit = folder.roleIds;
    // A limited folder must not hand its contents to a wider audience.
    const childRoles = new Map<string, string[]>();
    if (limit.length) {
      const [skills, memory] = await Promise.all([
        this.prisma.kgSkillSuggestion.count({ where: { organizationId, folderId: id } }),
        this.prisma.memoryItem.count({ where: { organizationId, folderId: id } }),
      ]);
      if (skills + memory > 0) {
        throw new ConflictException(
          `"${folder.path}" is limited to roles and still holds ${skills + memory} item(s). Move them or remove the limit first.`,
        );
      }
      // Subfolders keep the limit they inherited: an unlimited one takes it
      // over; a limited one keeps only the roles that satisfied both.
      for (const child of folders.filter((f) => f.parentId === id)) {
        const roles = child.roleIds.length ? child.roleIds.filter((r) => limit.includes(r)) : limit;
        if (!roles.length) {
          throw new ConflictException(
            `"${child.path}" and "${folder.path}" are limited to different roles. Adjust "${child.path}" first.`,
          );
        }
        childRoles.set(child.id, roles);
      }
    }
    const siblings = new Set(
      folders.filter((f) => f.parentId === parentId && f.id !== id).map((f) => f.name.toLowerCase()),
    );
    await this.prisma.$transaction(async (tx) => {
      for (const child of folders.filter((f) => f.parentId === id)) {
        let name = child.name;
        for (let n = 2; siblings.has(name.toLowerCase()); n++) name = `${child.name} (${n})`;
        siblings.add(name.toLowerCase());
        await tx.knowledgeFolder.update({
          where: { id: child.id },
          data: { parentId, name, ...(childRoles.has(child.id) ? { roleIds: childRoles.get(child.id) } : {}) },
        });
      }
      await tx.kgSkillSuggestion.updateMany({
        where: { organizationId, folderId: id },
        data: { folderId: parentId },
      });
      await tx.memoryItem.updateMany({
        where: { organizationId, folderId: id },
        data: { folderId: parentId },
      });
      await tx.knowledgeFolder.delete({ where: { id } });
    });
    return { ok: true, movedTo: parentId };
  }

  /** Limit a folder (and its subtree) to roles. Enterprise. Empty = everyone. */
  async setRoles(
    organizationId: string,
    id: string,
    roleIds: string[],
    ctx: FolderActionContext,
  ) {
    await this.edition.assertEnterprise(organizationId, 'Limiting folders to roles');
    const folders = await this.tree(organizationId);
    const folder = this.mustFind(folders, id);
    const wanted = [...new Set(roleIds)];
    if (wanted.length) {
      const roles = await this.prisma.role.findMany({
        where: { id: { in: wanted }, OR: [{ organizationId }, { organizationId: null }] },
        select: { id: true },
      });
      if (roles.length !== wanted.length) throw new BadRequestException('Unknown role.');
    }
    await this.prisma.knowledgeFolder.update({ where: { id }, data: { roleIds: wanted } });
    await this.securityEvents.log({
      event: SecurityEvents.KNOWLEDGE_FOLDER_ACCESS_CHANGED,
      actorType: 'USER',
      organizationId,
      actorUserId: ctx.actorUserId,
      metadata: { folderId: id, path: folder.path, from: folder.roleIds, to: wanted },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return (await this.tree(organizationId)).find((f) => f.id === id)!;
  }

  /**
   * Move skills or company memory items into a folder (`null` = top level).
   * Only items of this workspace move; personal memory never gets a folder.
   */
  async moveItems(
    organizationId: string,
    kind: 'skill' | 'memory',
    ids: string[],
    folderId: string | null,
    actorIsAdmin = false,
  ): Promise<{ moved: number }> {
    const folders = await this.tree(organizationId);
    if (folderId) this.mustFind(folders, folderId);
    const where = { organizationId, id: { in: [...new Set(ids)].slice(0, 500) } };
    if (!actorIsAdmin) {
      const current =
        kind === 'skill'
          ? await this.prisma.kgSkillSuggestion.findMany({ where, select: { folderId: true } })
          : await this.prisma.memoryItem.findMany({ where, select: { folderId: true } });
      if (current.some((r) => widensAccess(folders, r.folderId ?? null, folderId))) {
        throw new ForbiddenException(WIDEN_MESSAGE);
      }
    }
    const res =
      kind === 'skill'
        ? await this.prisma.kgSkillSuggestion.updateMany({ where, data: { folderId } })
        : await this.prisma.memoryItem.updateMany({
            where: { ...where, scope: 'organization' },
            data: { folderId },
          });
    return { moved: res.count };
  }

  /** A folder of this workspace the caller may see, by id or path; else 404. */
  resolveVisible(access: FolderAccess, ref: string): FolderNode {
    const f = resolveFolder(access.folders, ref);
    if (!f) throw new NotFoundException(`No folder "${ref}".`);
    return f;
  }

  private mustFind(folders: FolderNode[], id: string): FolderNode {
    const f = folders.find((x) => x.id === id);
    if (!f) throw new NotFoundException('Folder not found.');
    return f;
  }

  private assertFreeName(folders: FolderNode[], parentId: string | null, name: string, selfId?: string) {
    const taken = folders.some(
      (f) => f.parentId === parentId && f.id !== selfId && f.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) throw new ConflictException(`A folder "${name}" already exists there.`);
  }
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new BadRequestException('A folder needs a name.');
  if (name.includes('/')) throw new BadRequestException('A folder name cannot contain "/".');
  return name.slice(0, FOLDER_NAME_MAX);
}

function cleanDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw.trim();
  return d ? d.slice(0, FOLDER_DESCRIPTION_MAX) : null;
}
