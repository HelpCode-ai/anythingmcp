import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(organizationId?: string) {
    const roles = await this.prisma.role.findMany({
      where: organizationId
        ? { OR: [{ organizationId }, { isSystem: true }] }
        : undefined,
      include: {
        _count: { select: { toolAccess: true } },
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });

    // `_count.users` cannot come from the relation: `user_roles` is unique on
    // (user, role, SOURCE), so one person holding a role both manually and via
    // an IdP sync counts twice. Count DISTINCT users instead. Roles per org are
    // few, so one query and a Set is cheaper than a raw aggregate.
    const assignments = await this.prisma.userRoleAssignment.findMany({
      where: { roleId: { in: roles.map((r) => r.id) } },
      select: { roleId: true, userId: true },
    });
    const usersByRole = new Map<string, Set<string>>();
    for (const a of assignments) {
      const set = usersByRole.get(a.roleId) ?? new Set<string>();
      set.add(a.userId);
      usersByRole.set(a.roleId, set);
    }

    return roles.map((r) => ({
      ...r,
      _count: {
        ...r._count,
        users: usersByRole.get(r.id)?.size ?? 0,
      },
    }));
  }

  async findById(id: string) {
    return this.prisma.role.findUnique({
      where: { id },
      include: {
        toolAccess: {
          include: { tool: { select: { id: true, name: true, connector: { select: { name: true } } } } },
        },
        _count: { select: { toolAccess: true } },
      },
    });
  }

  /**
   * Like findById, but only returns the role if it belongs to the given
   * organization (or is a system role visible to all). Use this from any
   * controller that resolves a role from a user-supplied id.
   */
  async findByIdForOrg(id: string, organizationId: string) {
    return this.prisma.role.findFirst({
      where: {
        id,
        OR: [{ organizationId }, { isSystem: true }],
      },
      include: {
        toolAccess: {
          include: { tool: { select: { id: true, name: true, connector: { select: { name: true } } } } },
        },
        _count: { select: { toolAccess: true } },
      },
    });
  }

  async create(data: { name: string; description?: string; organizationId?: string }) {
    return this.prisma.role.create({
      data: { name: data.name, description: data.description, organizationId: data.organizationId },
    });
  }

  async update(id: string, organizationId: string, data: { name?: string; description?: string }) {
    const result = await this.prisma.role.updateMany({
      where: { id, organizationId },
      data,
    });
    if (result.count === 0) return null;
    return this.prisma.role.findUnique({ where: { id } });
  }

  async delete(id: string, organizationId: string) {
    // Only delete the role if it belongs to the given organization
    const role = await this.prisma.role.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!role) return false;
    // Unassign users first
    await this.prisma.user.updateMany({
      where: { mcpRoleId: id },
      data: { mcpRoleId: null },
    });
    await this.prisma.role.delete({ where: { id } });
    return true;
  }

  // ── Tool access management ────────────────────────────────────────────────

  async getToolAccess(roleId: string) {
    return this.prisma.toolRoleAccess.findMany({
      where: { roleId },
      include: { tool: { select: { id: true, name: true, description: true, connector: { select: { id: true, name: true } } } } },
    });
  }

  async setToolAccess(roleId: string, toolIds: string[], organizationId: string) {
    // System roles are global (organizationId is null), and `findByIdForOrg`
    // deliberately makes them visible to every org. `updateRole` and
    // `deleteRole` both refuse them; this path did not, so any org admin could
    // rewrite the tool whitelist of a role every other organization shares.
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { isSystem: true },
    });
    if (role?.isSystem) {
      throw new Error('Cannot modify tool access on a system role');
    }

    // Validate that every tool ID belongs to the given organization. This
    // prevents an admin from assigning tools owned by another org to a role
    // they control.
    if (toolIds.length > 0) {
      const validCount = await this.prisma.mcpTool.count({
        where: {
          id: { in: toolIds },
          connector: { organizationId },
        },
      });
      if (validCount !== toolIds.length) {
        throw new Error('One or more toolIds are not in this organization');
      }
    }
    // Replace all tool access for this role
    await this.prisma.$transaction([
      this.prisma.toolRoleAccess.deleteMany({ where: { roleId } }),
      ...toolIds.map((toolId) =>
        this.prisma.toolRoleAccess.create({
          data: { roleId, toolId },
        }),
      ),
    ]);
  }

  async addToolAccess(roleId: string, toolId: string) {
    return this.prisma.toolRoleAccess.upsert({
      where: { roleId_toolId: { roleId, toolId } },
      create: { roleId, toolId },
      update: {},
    });
  }

  async removeToolAccess(roleId: string, toolId: string) {
    await this.prisma.toolRoleAccess.deleteMany({
      where: { roleId, toolId },
    });
  }

  // ── Tool access query for MCP filtering ───────────────────────────────────

  /**
   * Tool IDs a user may use in the given organization.
   *
   *   null = unrestricted (ADMIN of that org, or no role assigned in an
   *          organization that does not use tool whitelists at all)
   *   []   = the assigned role(s) grant nothing, the caller is unknown / not a
   *          member, or the caller has no role in an organization that DOES
   *          use tool whitelists — always fail closed, never `null`
   *
   * With many-to-many roles the result is the UNION of every assigned role's
   * whitelist.
   *
   * The "no role" case is decided per organization (see the branch below):
   * a workspace that has never created a whitelist keeps the legacy
   * everything-allowed behaviour, while one that governs access with roles
   * treats a user nobody has granted anything as having nothing.
   */
  async getAllowedToolIds(
    userId: string,
    organizationId?: string,
  ): Promise<string[] | null> {
    // SECURITY: `userId` is the `users.id` cuid on every auth path — app JWTs
    // carry it in `sub`, and so do MCP OAuth tokens (LocalOAuthProvider maps
    // the profile `username` to the cuid). There is deliberately NO fallback
    // to `where: { email: userId }`: that turned a mutable, IdP-supplied email
    // into a lookup key for tool authorization, so a token bearing a victim's
    // email would inherit the victim's tool grants.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, organizationId: true },
    });

    // Unknown principal — fail closed (no tools), never `null`/unrestricted.
    if (!user) return [];

    // SECURITY: `users.role` is only a CACHE of the role in the user's active
    // organization (OrganizationsService refreshes it on switchOrg). Reading it
    // here granted unrestricted tool access across org boundaries: in cloud
    // every self-registered user is ADMIN of their own workspace, so anyone who
    // had ever signed up carried ADMIN in the cache and, when calling a
    // corporate org's /mcp/:serverId where they are merely a VIEWER, matched
    // the `=== 'ADMIN'` bypass below and received EVERY tool — straight past
    // that org's ToolRoleAccess whitelist.
    //
    // The authoritative per-org role lives in organization_members, so resolve
    // against the organization actually being acted on.
    const orgId = organizationId ?? user.organizationId ?? null;
    // An identified principal with no organization context gets no tools. The
    // old fallback to the `users.role` cache is exactly what a deactivated
    // user is left with once their active org is cleared, and it read ADMIN
    // as "everything".
    if (!orgId) return [];

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: { userId, organizationId: orgId },
      },
      select: { role: true, deactivatedAt: true },
    });
    // Not a member, or deactivated — fail closed. The endpoint-level tenant
    // check denies the first case first; this is defense in depth, not the
    // only gate. Deactivation is caught HERE for every MCP path at once.
    if (!membership || membership.deactivatedAt) return [];
    const effectiveRole: string = membership.role;

    // ADMIN of THIS organization always has full access
    if (effectiveRole === 'ADMIN') return null;

    // Every role assigned to the user IN THIS ORG, plus grants with no org,
    // which apply everywhere (that is how an `isSystem` role behaves).
    const assignments = await this.prisma.userRoleAssignment.findMany({
      where: {
        userId,
        ...(orgId
          ? { OR: [{ organizationId: orgId }, { organizationId: null }] }
          : {}),
      },
      select: { roleId: true },
    });

    // Deduplicated in JS rather than with Prisma's `distinct`, which for a
    // non-unique column is emulated client-side anyway — a Set is clearer.
    const roleIds = [...new Set(assignments.map((a) => a.roleId))];

    // No role assigned. Historically this meant "unrestricted", which fails
    // OPEN: a user nobody has granted anything received EVERY tool, and it
    // went unnoticed because `null` also legitimately means "ADMIN". Observed
    // in production on a self-hosted instance.
    //
    // The rule is now decided per organization, with no configuration:
    //   - the org has at least one tool whitelist → it governs access with
    //     roles, so "no role" means "no tools" (fail closed);
    //   - the org has never created a whitelist → nothing to enforce, keep
    //     returning `null` so workspaces that do not use RBAC are untouched.
    // The probe lives INSIDE this branch so anyone holding a role pays nothing.
    if (roleIds.length === 0) {
      if (!(await this.organizationUsesToolWhitelists(orgId))) return null;
      this.logger.warn(
        `User ${userId} has no role in organization ${orgId}, which uses tool whitelists — ` +
          'denying every tool. Assign them a role, or make them an ADMIN of the organization.',
      );
      return [];
    }

    // UNION of the assigned roles' whitelists: being in more groups can only
    // ever widen access, never narrow it.
    const access = await this.prisma.toolRoleAccess.findMany({
      where: { roleId: { in: roleIds } },
      select: { toolId: true },
    });

    return [...new Set(access.map((a) => a.toolId))];
  }

  /**
   * Whether any role OWNED BY this organization has a tool whitelist row.
   *
   * Deliberately scoped to the org's own roles and NOT widened to `isSystem`
   * roles: a single whitelist row on a global role would flip every
   * organization on the instance to fail-closed at once. Both sides are
   * index-covered (`roles` by organizationId, `tool_role_access` by roleId).
   */
  private async organizationUsesToolWhitelists(
    organizationId: string,
  ): Promise<boolean> {
    const row = await this.prisma.toolRoleAccess.findFirst({
      where: { role: { organizationId } },
      select: { id: true },
    });
    return row !== null;
  }

  // ── User role assignment ──────────────────────────────────────────────────

  /**
   * Replaces the user's MANUAL role assignments in one organization.
   *
   * Grants with `source` other than 'manual' — an IdP sync, for instance — are
   * left alone, so an admin editing roles by hand never silently undoes what a
   * group mapping granted, and vice versa.
   *
   * Returns null when the user is not in the org or a role is not visible to
   * it, which the controller turns into a 404.
   */
  async setUserRoles(
    userId: string,
    roleIds: string[],
    organizationId: string,
  ): Promise<{ userId: string; roleIds: string[] } | null> {
    // Membership check against organization_members, not `users.organizationId`
    // — the latter is only the ACTIVE org, so a multi-org user would be
    // editable or not depending on which workspace they happen to be viewing.
    const membership = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { userId: true },
    });
    if (!membership) return null;

    const unique = [...new Set(roleIds)];
    if (unique.length > 0) {
      // Every role must be org-owned or a system role, so an admin cannot
      // attach a role belonging to a different organization.
      const valid = await this.prisma.role.count({
        where: {
          id: { in: unique },
          OR: [{ organizationId }, { isSystem: true }],
        },
      });
      if (valid !== unique.length) return null;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRoleAssignment.deleteMany({
        where: { userId, organizationId, source: 'manual' },
      });
      if (unique.length > 0) {
        await tx.userRoleAssignment.createMany({
          data: unique.map((roleId) => ({
            userId,
            roleId,
            organizationId,
            source: 'manual',
          })),
          skipDuplicates: true,
        });
      }
      // Keep the deprecated scalar in step so a rollback to the previous
      // release still sees a sensible value. Lossy by definition — one of N.
      await tx.user.update({
        where: { id: userId },
        data: { mcpRoleId: unique[0] ?? null },
      });
    });

    await this.warnOnEmptyRoles(unique, userId);

    return { userId, roleIds: unique };
  }

  /**
   * @deprecated Single-role adapter kept for the previous API shape. A browser
   * tab holding a stale frontend bundle is the real caller here, since frontend
   * and backend ship in the same container.
   */
  async assignRoleToUser(
    userId: string,
    roleId: string | null,
    organizationId: string,
  ) {
    return this.setUserRoles(userId, roleId ? [roleId] : [], organizationId);
  }

  /** Role ids assigned to a user in an organization, with their provenance. */
  async getUserRoles(userId: string, organizationId: string) {
    return this.prisma.userRoleAssignment.findMany({
      where: {
        userId,
        OR: [{ organizationId }, { organizationId: null }],
      },
      select: {
        roleId: true,
        source: true,
        role: { select: { id: true, name: true } },
      },
    });
  }

  // ── Seed system roles ─────────────────────────────────────────────────────

  // `ensureSystemRoles()` used to live here, seeding a system role named
  // "Full Access" with NO tool access rows. That is the exact inverse of its
  // name: a role with an empty whitelist grants ZERO tools, so assigning it
  // locked the user out of everything.
  //
  // It was never called outside its own spec, which is the only reason it never
  // bit. Removed rather than repaired because the product already has a "full
  // access" state: being an ADMIN of the organization, or — in an organization
  // that has never created a tool whitelist — simply having no role. Once an
  // organization uses whitelists, `getAllowedToolIds` fails closed for a user
  // with no role, so "full access" there is the ADMIN membership, not a role.
  //
  // The lockout shape itself still exists for any hand-made empty role, which
  // is why `setUserRoles` warns about it — see `warnOnEmptyRoles`.

  /**
   * Logs when a user is given a role that grants no tools at all.
   *
   * Not blocked: an admin may legitimately create a role and populate it
   * afterwards. But an empty role denies EVERYTHING, which reads backwards to
   * most people, so it should not happen silently. Note that removing the
   * assignment does not necessarily help either: in an organization that uses
   * tool whitelists a user with no role is denied everything as well (see
   * `getAllowedToolIds`), so the remedy is to add tools to the role.
   */
  private async warnOnEmptyRoles(roleIds: string[], userId: string) {
    if (roleIds.length === 0) return;
    const withTools = await this.prisma.toolRoleAccess.findMany({
      where: { roleId: { in: roleIds } },
      select: { roleId: true },
      distinct: ['roleId'],
    });
    const granting = new Set(withTools.map((t) => t.roleId));
    const empty = roleIds.filter((id) => !granting.has(id));
    if (empty.length > 0) {
      this.logger.warn(
        `User ${userId} assigned role(s) with an empty tool whitelist (${empty.join(', ')}) — ` +
          'an empty role grants NO tools. Add tools to it, or assign a role that has some.',
      );
    }
  }
}
