import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../audit/security-event.service';
import type { RoleSyncFallback, RoleSyncSource, UserRole } from '../generated/prisma/client';

/**
 * `source` written on every assignment this service owns. It is part of the
 * unique key on `user_roles`, which is what keeps a sync from ever deleting a
 * grant an admin made by hand — and vice versa.
 */
export const SYNC_SOURCE = 'entra';

/**
 * Name of the per-organization role that expresses "role sync ran and matched
 * nothing". See `applyDenyAll` for why this exists instead of simply deleting
 * the user's grants.
 */
export const DENY_ALL_ROLE_NAME = 'No access (SSO)';

/** Ordered least- to most-privileged. Index is the comparison key. */
const ORG_ROLE_RANK: UserRole[] = ['VIEWER', 'EDITOR', 'ADMIN'];

export interface RoleSyncProvider {
  id: string;
  organizationId: string;
  roleSyncEnabled: boolean;
  roleSyncSource: RoleSyncSource;
  roleSyncFallback: RoleSyncFallback;
  roleSyncDefaultRoleIds: string[];
}

export type RoleSyncReason =
  | 'disabled'
  | 'overage'
  | 'no_claim'
  | 'matched'
  | 'fallback_deny_all'
  | 'fallback_keep_existing'
  | 'fallback_default_role';

export interface RoleSyncOutcome {
  /** False means nothing was written. */
  applied: boolean;
  reason: RoleSyncReason;
  /** How many ids the token presented. */
  presented: number;
  /** How many mappings those ids hit. */
  matched: number;
  grantedRoleIds: string[];
  orgRoleBefore?: UserRole;
  orgRoleAfter?: UserRole;
  /** True when a demotion was refused because it would empty the org of admins. */
  lastAdminProtected?: boolean;
}

/**
 * Projects an external directory's groups (or application roles) onto
 * AnythingMCP roles, on every sign-in.
 *
 * Three properties this service is built around:
 *
 * 1. It matches on OBJECT IDS, never display names. Entra group names are not
 *    unique and anyone able to create a group could otherwise mint one whose
 *    name matches a privileged mapping.
 *
 * 2. It refuses to act on incomplete claims. A token that overflowed the group
 *    limit carries a `_claim_names` pointer instead of the list; treating that
 *    as "member of nothing" would revoke access from exactly the people who
 *    belong to the most groups.
 *
 * 3. It never touches assignments a human made. Only rows with
 *    `source = 'entra'` are its to rewrite.
 */
@Injectable()
export class RoleSyncService {
  private readonly logger = new Logger(RoleSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  /**
   * Runs a sync for one sign-in. Never throws: a directory that returns
   * something unexpected must not turn a valid authentication into a failed
   * login, so problems are logged and audited and the user keeps whatever
   * they already had.
   */
  async syncOnLogin(
    provider: RoleSyncProvider,
    userId: string,
    claims: Record<string, any>,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<RoleSyncOutcome> {
    try {
      return await this.run(provider, userId, claims, ctx);
    } catch (e: any) {
      this.logger.error(
        `Role sync failed for provider ${provider.id}: ${e?.message}`,
      );
      await this.securityEvents.log({
        event: SecurityEvents.ROLE_SYNC_FAILED,
        actorType: 'SYSTEM',
        organizationId: provider.organizationId,
        targetUserId: userId,
        metadata: { providerId: provider.id, error: String(e?.message ?? e) },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { applied: false, reason: 'disabled', presented: 0, matched: 0, grantedRoleIds: [] };
    }
  }

  private async run(
    provider: RoleSyncProvider,
    userId: string,
    claims: Record<string, any>,
    ctx: { ip?: string | null; userAgent?: string | null },
  ): Promise<RoleSyncOutcome> {
    if (!provider.roleSyncEnabled) {
      return { applied: false, reason: 'disabled', presented: 0, matched: 0, grantedRoleIds: [] };
    }

    // Entra replaces the claim with a Graph URL past ~150 groups (~200 for
    // SAML). The list we would read is then simply absent, and every mapping
    // would miss. Acting on that would silently strip the roles of the most
    // heavily-grouped users in the directory — so we do nothing at all and say
    // so loudly. Resolving the overage needs Graph `GroupMember.Read.All`,
    // which this product deliberately does not ask for.
    if (this.hasOverage(provider.roleSyncSource, claims)) {
      this.logger.warn(
        `Role sync skipped: token from provider ${provider.id} signalled a groups overage`,
      );
      await this.securityEvents.log({
        event: SecurityEvents.ROLE_SYNC_SKIPPED,
        actorType: 'SYSTEM',
        organizationId: provider.organizationId,
        targetUserId: userId,
        metadata: { providerId: provider.id, reason: 'overage' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { applied: false, reason: 'overage', presented: 0, matched: 0, grantedRoleIds: [] };
    }

    const presented = this.extractIds(provider.roleSyncSource, claims);

    const mappings = await this.prisma.identityProviderRoleMapping.findMany({
      where: { providerId: provider.id },
      select: { externalId: true, userRole: true, mcpRoleIds: true },
    });

    // Set membership rather than a nested loop: a Führungskreis member can
    // easily present a hundred groups against a few dozen mappings.
    const presentedSet = new Set(presented);
    const matches = mappings.filter((m) => presentedSet.has(m.externalId));

    if (matches.length === 0) {
      return this.applyFallback(provider, userId, presented.length, ctx);
    }

    const desiredMcpRoleIds = [
      ...new Set(matches.flatMap((m) => m.mcpRoleIds)),
    ];
    // Being in more groups can only ever widen access, so the org role is the
    // most privileged of the matches — not the last one read.
    const desiredOrgRole = this.highestOrgRole(
      matches.map((m) => m.userRole).filter((r): r is UserRole => r != null),
    );

    const granted = await this.writeAssignments(
      provider,
      userId,
      desiredMcpRoleIds,
    );
    const org = await this.writeOrgRole(provider, userId, desiredOrgRole, ctx);

    await this.securityEvents.log({
      event: SecurityEvents.ROLE_SYNC_APPLIED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      targetUserId: userId,
      metadata: {
        providerId: provider.id,
        source: provider.roleSyncSource,
        presented: presented.length,
        matched: matches.length,
        grantedRoleIds: granted,
        orgRoleBefore: org.before,
        orgRoleAfter: org.after,
        lastAdminProtected: org.lastAdminProtected,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return {
      applied: true,
      reason: 'matched',
      presented: presented.length,
      matched: matches.length,
      grantedRoleIds: granted,
      orgRoleBefore: org.before,
      orgRoleAfter: org.after,
      lastAdminProtected: org.lastAdminProtected,
    };
  }

  // ── Claim reading ─────────────────────────────────────────────────────────

  private hasOverage(source: RoleSyncSource, claims: Record<string, any>) {
    if (source !== 'GROUPS') return false;
    const names = claims._claim_names;
    return Boolean(names && typeof names === 'object' && 'groups' in names);
  }

  /**
   * Entra puts group object ids in `groups` and application role `value`s in
   * `roles`. Both are arrays of strings; anything else is treated as absent
   * rather than coerced, because a directory that suddenly sends a different
   * shape is a reason to grant nothing, not to guess.
   */
  private extractIds(
    source: RoleSyncSource,
    claims: Record<string, any>,
  ): string[] {
    const raw = source === 'APP_ROLES' ? claims.roles : claims.groups;
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  private highestOrgRole(roles: UserRole[]): UserRole | null {
    let best: UserRole | null = null;
    for (const r of roles) {
      if (best === null || ORG_ROLE_RANK.indexOf(r) > ORG_ROLE_RANK.indexOf(best)) {
        best = r;
      }
    }
    return best;
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * Rewrites this user's SYNCED role grants in the provider's organization to
   * exactly `roleIds`, leaving manual grants untouched.
   *
   * Ids are re-validated against the organization before use: a mapping row
   * can outlive the role it points at, or name a role belonging to another
   * workspace if one was ever moved.
   */
  private async writeAssignments(
    provider: RoleSyncProvider,
    userId: string,
    roleIds: string[],
  ): Promise<string[]> {
    const valid =
      roleIds.length === 0
        ? []
        : (
            await this.prisma.role.findMany({
              where: {
                id: { in: roleIds },
                OR: [{ organizationId: provider.organizationId }, { isSystem: true }],
              },
              select: { id: true },
            })
          ).map((r) => r.id);

    if (valid.length !== roleIds.length) {
      this.logger.warn(
        `Role sync for provider ${provider.id} dropped ${roleIds.length - valid.length} mapped role id(s) not visible to org ${provider.organizationId}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRoleAssignment.deleteMany({
        where: {
          userId,
          source: SYNC_SOURCE,
          organizationId: provider.organizationId,
          ...(valid.length > 0 ? { roleId: { notIn: valid } } : {}),
        },
      });
      if (valid.length > 0) {
        await tx.userRoleAssignment.createMany({
          data: valid.map((roleId) => ({
            userId,
            roleId,
            organizationId: provider.organizationId,
            source: SYNC_SOURCE,
            externalRef: provider.id,
          })),
          skipDuplicates: true,
        });
      }
    });

    // `users.mcp_role_id` is deliberately NOT written here. It holds one role
    // where a sync produces N, and it is dropped in the contract migration; a
    // release rolled back to before role sync existed should see no synced
    // roles, which is exactly what leaving it alone produces.
    return valid;
  }

  /**
   * Moves the user's organization role, refusing any change that would leave
   * the workspace with no administrator.
   */
  private async writeOrgRole(
    provider: RoleSyncProvider,
    userId: string,
    desired: UserRole | null,
    ctx: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ before?: UserRole; after?: UserRole; lastAdminProtected?: boolean }> {
    if (desired === null) return {};

    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: { userId, organizationId: provider.organizationId },
      },
      select: { role: true },
    });
    if (!membership) return {};
    if (membership.role === desired) return { before: membership.role, after: desired };

    // A directory edit must not be able to lock every human out of a
    // workspace. Only the demotion direction can do that, so only it is
    // guarded — promotion is always allowed.
    if (membership.role === 'ADMIN' && desired !== 'ADMIN') {
      const admins = await this.prisma.organizationMember.count({
        where: { organizationId: provider.organizationId, role: 'ADMIN' },
      });
      if (admins <= 1) {
        this.logger.warn(
          `Role sync refused to demote the last admin of org ${provider.organizationId}`,
        );
        await this.securityEvents.log({
          event: SecurityEvents.LAST_ADMIN_PROTECTION_TRIGGERED,
          actorType: 'SYSTEM',
          organizationId: provider.organizationId,
          targetUserId: userId,
          metadata: { providerId: provider.id, attemptedRole: desired },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return { before: membership.role, after: membership.role, lastAdminProtected: true };
      }
    }

    await this.prisma.organizationMember.update({
      where: {
        userId_organizationId: { userId, organizationId: provider.organizationId },
      },
      data: { role: desired },
    });
    await this.securityEvents.log({
      event: SecurityEvents.ROLE_CHANGED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      targetUserId: userId,
      metadata: { providerId: provider.id, from: membership.role, to: desired, via: 'role_sync' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { before: membership.role, after: desired };
  }

  // ── Fallbacks ─────────────────────────────────────────────────────────────

  private async applyFallback(
    provider: RoleSyncProvider,
    userId: string,
    presented: number,
    ctx: { ip?: string | null; userAgent?: string | null },
  ): Promise<RoleSyncOutcome> {
    if (provider.roleSyncFallback === 'KEEP_EXISTING') {
      return {
        applied: false,
        reason: 'fallback_keep_existing',
        presented,
        matched: 0,
        grantedRoleIds: [],
      };
    }

    if (provider.roleSyncFallback === 'DEFAULT_ROLE') {
      const granted = await this.writeAssignments(
        provider,
        userId,
        provider.roleSyncDefaultRoleIds,
      );
      await this.audit(provider, userId, 'fallback_default_role', presented, granted, ctx);
      return {
        applied: true,
        reason: 'fallback_default_role',
        presented,
        matched: 0,
        grantedRoleIds: granted,
      };
    }

    const granted = await this.applyDenyAll(provider, userId);
    await this.audit(provider, userId, 'fallback_deny_all', presented, granted, ctx);
    return {
      applied: true,
      reason: 'fallback_deny_all',
      presented,
      matched: 0,
      grantedRoleIds: granted,
    };
  }

  /**
   * DENY_ALL cannot be implemented by deleting the user's grants.
   *
   * `RolesService.getAllowedToolIds` returns `null` — meaning UNRESTRICTED —
   * for a user with no role at all, which is the behaviour inherited from the
   * single-FK era. So "revoke everything" written the obvious way produces
   * full access: the precise failure this fallback exists to prevent.
   *
   * Instead the user is given a real role that whitelists nothing. The union
   * of an empty whitelist is empty, so every existing access check already
   * does the right thing with it, and an admin can see in the roles UI why
   * someone has no tools rather than having to infer it from an absence.
   */
  private async applyDenyAll(
    provider: RoleSyncProvider,
    userId: string,
  ): Promise<string[]> {
    const role = await this.prisma.role.upsert({
      where: {
        organizationId_name: {
          organizationId: provider.organizationId,
          name: DENY_ALL_ROLE_NAME,
        },
      },
      create: {
        organizationId: provider.organizationId,
        name: DENY_ALL_ROLE_NAME,
        description:
          'Assigned automatically when SSO role sync finds no matching group mapping. Grants no tools. Do not add tool access to this role.',
      },
      update: {},
      select: { id: true },
    });
    return this.writeAssignments(provider, userId, [role.id]);
  }

  private async audit(
    provider: RoleSyncProvider,
    userId: string,
    reason: RoleSyncReason,
    presented: number,
    grantedRoleIds: string[],
    ctx: { ip?: string | null; userAgent?: string | null },
  ) {
    await this.securityEvents.log({
      event: SecurityEvents.ROLE_SYNC_APPLIED,
      actorType: 'SYSTEM',
      organizationId: provider.organizationId,
      targetUserId: userId,
      metadata: {
        providerId: provider.id,
        source: provider.roleSyncSource,
        reason,
        presented,
        matched: 0,
        grantedRoleIds,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
