import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../../audit/security-event.service';
import { RoleSyncService } from '../role-sync.service';
import { ScimError } from './scim.errors';
import { isRecord, memberIdFromPath, parsePatch, PatchOp, ScimFilter } from './scim.parser';
import { SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA } from './scim.schemas';
import type { ScimProvider } from './scim-auth.guard';
import type { ScimCtx } from './scim-users.service';

const GROUP_INCLUDE = {
  members: { select: { userId: true, user: { select: { email: true } } } },
} as const;

type GroupRow = {
  id: string;
  providerId: string;
  externalId: string | null;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
  members: { userId: string; user: { email: string } }[];
};

/**
 * SCIM Groups for one identity provider.
 *
 * Entra pushes a group when it is assigned to the application, and then
 * every membership delta. What we keep is the group's object id, its display
 * name and who is in it; what we do with it is re-run the role sync for every
 * affected user, so a group change reaches their MCP tools on the next request
 * — no sign-in involved.
 */
@Injectable()
export class ScimGroupsService {
  private readonly logger = new Logger(ScimGroupsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
    private readonly roleSync: RoleSyncService,
  ) {}

  // ── Read ──────────────────────────────────────────────────────────────────

  async list(
    provider: ScimProvider,
    filter: ScimFilter | null,
    page: { startIndex: number; count: number },
    excluded: Set<string>,
    ctx: ScimCtx,
  ) {
    const where = { providerId: provider.id, ...this.whereFor(filter) };
    const [total, rows] = await Promise.all([
      this.prisma.identityProviderGroup.count({ where }),
      this.prisma.identityProviderGroup.findMany({
        where,
        include: GROUP_INCLUDE,
        orderBy: { createdAt: 'asc' },
        skip: page.startIndex - 1,
        take: page.count,
      }),
    ]);
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      startIndex: page.startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((r) => this.toScim(r as GroupRow, ctx, !excluded.has('members'))),
    };
  }

  async get(provider: ScimProvider, id: string, excluded: Set<string>, ctx: ScimCtx) {
    return this.toScim(await this.find(provider, id), ctx, !excluded.has('members'));
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  async create(provider: ScimProvider, body: unknown, ctx: ScimCtx) {
    const parsed = this.readGroup(body);
    if (parsed.externalId) {
      const dup = await this.prisma.identityProviderGroup.findUnique({
        where: { providerId_externalId: { providerId: provider.id, externalId: parsed.externalId } },
        select: { id: true },
      });
      if (dup) throw new ScimError(409, 'Group already provisioned', 'uniqueness');
    }

    const members = await this.validMembers(provider, parsed.memberIds);
    const group = await this.prisma.identityProviderGroup.create({
      data: {
        providerId: provider.id,
        externalId: parsed.externalId ?? null,
        displayName: parsed.displayName,
        members: { create: members.valid.map((userId) => ({ userId })) },
      },
      include: GROUP_INCLUDE,
    });

    // The mapping row, if an admin already created one by object id, gets the
    // real name. Nothing else about it changes — its roles are the admin's.
    await this.copyLabel(provider, group.externalId, group.displayName);

    await this.securityEvents.log({
      event: SecurityEvents.SCIM_GROUP_CREATED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      metadata: {
        providerId: provider.id,
        groupId: group.id,
        externalId: group.externalId,
        displayName: group.displayName,
        members: members.valid.length,
        skippedMemberIds: members.skipped.join(','),
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    await this.resync(provider, members.valid, ctx);
    return this.toScim(group as GroupRow, ctx, true);
  }

  async replace(provider: ScimProvider, id: string, body: unknown, ctx: ScimCtx) {
    const group = await this.find(provider, id);
    const parsed = this.readGroup(body);
    if (parsed.externalId && group.externalId && parsed.externalId !== group.externalId) {
      throw new ScimError(400, 'externalId is immutable', 'mutability');
    }
    const members = await this.validMembers(provider, parsed.memberIds);
    const before = new Set(group.members.map((m) => m.userId));
    const after = new Set(members.valid);

    await this.prisma.$transaction(async (tx) => {
      await tx.identityProviderGroup.update({
        where: { id },
        data: { displayName: parsed.displayName, ...(group.externalId ? {} : { externalId: parsed.externalId ?? null }) },
      });
      const removed = [...before].filter((u) => !after.has(u));
      const added = [...after].filter((u) => !before.has(u));
      if (removed.length) await tx.identityProviderGroupMember.deleteMany({ where: { groupId: id, userId: { in: removed } } });
      if (added.length) await tx.identityProviderGroupMember.createMany({ data: added.map((userId) => ({ groupId: id, userId })), skipDuplicates: true });
    });
    await this.copyLabel(provider, group.externalId, parsed.displayName);

    const affected = [...new Set([...before, ...after])].filter((u) => before.has(u) !== after.has(u));
    await this.auditMembership(provider, group, affected.filter((u) => after.has(u)).length, affected.filter((u) => !after.has(u)).length, members.skipped, ctx);
    await this.resync(provider, affected, ctx);
    return this.get(provider, id, new Set(), ctx);
  }

  async patch(provider: ScimProvider, id: string, body: unknown, ctx: ScimCtx) {
    const group = await this.find(provider, id);
    const ops = parsePatch(body);
    const toAdd = new Set<string>();
    const toRemove = new Set<string>();
    let displayName: string | undefined;

    for (const op of ops) {
      const path = (op.path ?? '').toLowerCase();
      if (path === 'displayname' && typeof op.value === 'string' && op.value.trim()) {
        displayName = op.value.trim();
        continue;
      }
      const single = memberIdFromPath(op.path);
      if (single) {
        if (op.op === 'remove') toRemove.add(single);
        continue;
      }
      if (path === 'members') {
        for (const v of this.memberValues(op)) (op.op === 'remove' ? toRemove : toAdd).add(v);
      }
      // Anything else is an attribute we have no column for. Ignored.
    }
    // `remove` with no value on `members` empties the group.
    if (ops.some((o) => o.op === 'remove' && (o.path ?? '').toLowerCase() === 'members' && o.value === undefined)) {
      for (const m of group.members) toRemove.add(m.userId);
    }

    const members = await this.validMembers(provider, [...toAdd]);
    const existing = new Set(group.members.map((m) => m.userId));
    const added = members.valid.filter((u) => !existing.has(u));
    const removed = [...toRemove].filter((u) => existing.has(u));

    await this.prisma.$transaction(async (tx) => {
      if (displayName) await tx.identityProviderGroup.update({ where: { id }, data: { displayName } });
      if (removed.length) await tx.identityProviderGroupMember.deleteMany({ where: { groupId: id, userId: { in: removed } } });
      if (added.length) await tx.identityProviderGroupMember.createMany({ data: added.map((userId) => ({ groupId: id, userId })), skipDuplicates: true });
    });
    if (displayName) await this.copyLabel(provider, group.externalId, displayName);

    if (added.length || removed.length || members.skipped.length) {
      await this.auditMembership(provider, group, added.length, removed.length, members.skipped, ctx);
    }
    await this.resync(provider, [...added, ...removed], ctx);
    return this.get(provider, id, new Set(), ctx);
  }

  /** A deleted group takes its memberships with it; every former member is re-synced. */
  async remove(provider: ScimProvider, id: string, ctx: ScimCtx): Promise<void> {
    const group = await this.find(provider, id);
    const former = group.members.map((m) => m.userId);
    await this.prisma.identityProviderGroup.delete({ where: { id } });
    await this.securityEvents.log({
      event: SecurityEvents.SCIM_GROUP_DELETED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      metadata: { providerId: provider.id, groupId: id, externalId: group.externalId, displayName: group.displayName, members: former.length },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.resync(provider, former, ctx);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async find(provider: ScimProvider, id: string): Promise<GroupRow> {
    const row = await this.prisma.identityProviderGroup.findFirst({
      where: { id, providerId: provider.id },
      include: GROUP_INCLUDE,
    });
    if (!row) throw new ScimError(404, 'Group not found', 'noTarget');
    return row as GroupRow;
  }

  private whereFor(filter: ScimFilter | null) {
    if (!filter) return {};
    switch (filter.attr) {
      case 'displayName':
        return { displayName: { equals: filter.value, mode: 'insensitive' as const } };
      case 'externalId':
        return { externalId: filter.value };
      case 'id':
        return { id: filter.value };
      default:
        throw new ScimError(400, `Unsupported filter attribute: ${filter.attr}`, 'invalidFilter');
    }
  }

  private readGroup(body: unknown): { displayName: string; externalId?: string; memberIds: string[] } {
    if (!isRecord(body)) throw new ScimError(400, 'Request body must be an object', 'invalidSyntax');
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
    const externalId = typeof body.externalId === 'string' && body.externalId.trim() ? body.externalId.trim() : undefined;
    const memberIds = Array.isArray(body.members)
      ? [...new Set(body.members.filter(isRecord).map((m) => m.value).filter((v): v is string => typeof v === 'string' && v.length > 0))]
      : [];
    return { displayName, externalId, memberIds };
  }

  private memberValues(op: PatchOp): string[] {
    const v = op.value;
    const list = Array.isArray(v) ? v : isRecord(v) ? [v] : [];
    return [...new Set(list.filter(isRecord).map((m) => m.value).filter((x): x is string => typeof x === 'string' && x.length > 0))];
  }

  /**
   * Members must be users with an identity at THIS provider. Ids that are not
   * are skipped and reported, not fatal: failing the whole PATCH over one
   * out-of-scope id would block role sync for every legitimate member, and
   * Entra re-sends group updates after the missing user is provisioned.
   */
  private async validMembers(provider: ScimProvider, ids: string[]): Promise<{ valid: string[]; skipped: string[] }> {
    if (ids.length === 0) return { valid: [], skipped: [] };
    const known = await this.prisma.userIdentity.findMany({
      where: { providerId: provider.id, userId: { in: ids } },
      select: { userId: true },
    });
    const ok = new Set(known.map((k) => k.userId));
    return { valid: ids.filter((i) => ok.has(i)), skipped: ids.filter((i) => !ok.has(i)) };
  }

  private async copyLabel(provider: ScimProvider, externalId: string | null, displayName: string) {
    if (!externalId) return;
    await this.prisma.identityProviderRoleMapping.updateMany({
      where: { providerId: provider.id, externalId },
      data: { label: displayName },
    });
  }

  private async resync(provider: ScimProvider, userIds: string[], ctx: ScimCtx) {
    if (userIds.length === 0) return;
    await this.roleSync.resyncUsers(provider, userIds, { ip: ctx.ip, userAgent: ctx.userAgent }, 'scim');
  }

  private async auditMembership(provider: ScimProvider, group: GroupRow, added: number, removed: number, skipped: string[], ctx: ScimCtx) {
    await this.securityEvents.log({
      event: SecurityEvents.SCIM_GROUP_MEMBERSHIP_CHANGED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      metadata: {
        providerId: provider.id,
        groupId: group.id,
        externalId: group.externalId,
        added,
        removed,
        // Joined, not an array: keeps the row under the redactor's depth bound.
        skippedMemberIds: skipped.join(','),
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  private toScim(row: GroupRow, ctx: ScimCtx, includeMembers: boolean) {
    return {
      schemas: [SCIM_GROUP_SCHEMA],
      id: row.id,
      ...(row.externalId ? { externalId: row.externalId } : {}),
      displayName: row.displayName,
      ...(includeMembers
        ? { members: row.members.map((m) => ({ value: m.userId, display: m.user.email })) }
        : {}),
      meta: {
        resourceType: 'Group',
        created: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        location: `${ctx.baseUrl}/Groups/${row.id}`,
      },
    };
  }
}
