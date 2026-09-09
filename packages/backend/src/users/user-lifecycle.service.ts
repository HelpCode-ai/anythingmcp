import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { UserRole } from '../generated/prisma/client';
import {
  SecurityEventService,
  SecurityEvents,
} from '../audit/security-event.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { LastAdminConflictException } from '../organizations/last-admin.exception';

export type LifecycleReason = 'admin' | 'scim' | 'system';

export interface LifecycleContext {
  reason: LifecycleReason;
  actor: { type: 'USER' | 'SYSTEM'; userId?: string | null };
  /** Set when a directory push (SCIM) is the origin. */
  providerId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type DeactivateResult =
  | {
      status: 'deactivated';
      keysDeactivated: number;
      previousRole: UserRole;
      activeOrgRepointedTo: string | null;
    }
  /**
   * The directory asked to deactivate the only active admin. Sessions and
   * keys were revoked — the leaver has lost MCP and dashboard access — but
   * the membership stays active so the workspace keeps one way back in.
   */
  | { status: 'last_admin_retained'; keysDeactivated: number }
  | { status: 'already_inactive' }
  | { status: 'not_a_member' };

export type ReactivateResult =
  | { status: 'reactivated'; role: UserRole }
  | { status: 'already_active' }
  | { status: 'not_a_member' };

/**
 * The one place that removes a person's access to a workspace.
 *
 * "Deactivate" has to close every path at once — dashboard tokens, MCP OAuth
 * tokens, MCP API keys, and the membership itself — because each is checked
 * by different code and a leaver who keeps any one of them has not left. The
 * admin's Deactivate button and SCIM's `active: false` both land here so the
 * two can never drift apart.
 */
@Injectable()
export class UserLifecycleService {
  private readonly logger = new Logger(UserLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async deactivateInOrganization(
    userId: string,
    organizationId: string,
    ctx: LifecycleContext,
  ): Promise<DeactivateResult> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true, deactivatedAt: true },
    });
    if (!membership) return { status: 'not_a_member' };
    if (membership.deactivatedAt) return { status: 'already_inactive' };

    // Last-admin protection. An admin gets a refusal and promotes someone
    // first. A directory push cannot be argued with, so for it we still
    // revoke everything that grants ACCESS — sessions and keys — and keep
    // only the membership, which is what lets someone recover the workspace.
    let lastAdmin = false;
    try {
      await this.organizations.assertNotLastAdmin(organizationId, userId);
    } catch (e) {
      if (!(e instanceof LastAdminConflictException)) throw e;
      if (ctx.reason === 'admin') throw e;
      lastAdmin = true;
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      if (!lastAdmin) {
        await tx.organizationMember.update({
          where: { userId_organizationId: { userId, organizationId } },
          data: { deactivatedAt: now },
        });
      }

      // Keys are org-scoped: a multi-workspace user keeps the keys they use
      // elsewhere.
      const keys = await tx.mcpApiKey.findMany({
        where: { userId, organizationId, isActive: true },
        select: { id: true },
      });
      if (keys.length > 0) {
        await tx.mcpApiKey.updateMany({
          where: { id: { in: keys.map((k) => k.id) } },
          data: { isActive: false },
        });
      }

      // `sessionsValidFrom` is deliberately global. Neither token family is
      // org-scoped for revocation — both resolve the organization from the
      // user row — so a per-membership cutover would need a second column and
      // a check in every token path, to spare a multi-org user one re-login.
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { organizationId: true },
      });
      let repointedTo: string | null = null;
      const data: { sessionsValidFrom: Date; organizationId?: string | null; role?: UserRole } = {
        sessionsValidFrom: now,
      };
      if (!lastAdmin && user?.organizationId === organizationId) {
        const next = await tx.organizationMember.findFirst({
          where: { userId, deactivatedAt: null, organizationId: { not: organizationId } },
          orderBy: { joinedAt: 'asc' },
          select: { organizationId: true, role: true },
        });
        data.organizationId = next?.organizationId ?? null;
        if (next) data.role = next.role;
        repointedTo = next?.organizationId ?? null;
      }
      await tx.user.update({ where: { id: userId }, data });

      return { keyIds: keys.map((k) => k.id), repointedTo };
    });

    const base = {
      organizationId,
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      targetUserId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    } as const;

    if (lastAdmin) {
      this.logger.warn(
        `Refused to deactivate the last admin of org ${organizationId} (reason ${ctx.reason}); sessions and keys revoked, membership kept`,
      );
      await this.securityEvents.log({
        ...base,
        event: SecurityEvents.LAST_ADMIN_PROTECTION_TRIGGERED,
        metadata: { reason: ctx.reason, providerId: ctx.providerId ?? null, action: 'deactivate' },
      });
    } else {
      await this.securityEvents.log({
        ...base,
        event: SecurityEvents.USER_DEACTIVATED,
        metadata: {
          reason: ctx.reason,
          providerId: ctx.providerId ?? null,
          previousRole: membership.role,
          keysDeactivated: result.keyIds.length,
          activeOrgRepointedTo: result.repointedTo,
        },
      });
    }
    await this.securityEvents.log({
      ...base,
      event: SecurityEvents.SESSIONS_REVOKED,
      metadata: { reason: 'deactivation', organizationId },
    });
    if (result.keyIds.length > 0) {
      // `keyIds`, not `apiKeyIds`: the redactor blanks any metadata key that
      // looks like "api_key", and an audit row saying "[REDACTED]" here would
      // hide the one fact an investigation wants.
      await this.securityEvents.log({
        ...base,
        event: SecurityEvents.API_KEY_DEACTIVATED,
        metadata: { reason: 'deactivation', keyCount: result.keyIds.length, keyIds: result.keyIds },
      });
    }

    if (lastAdmin) {
      return { status: 'last_admin_retained', keysDeactivated: result.keyIds.length };
    }
    return {
      status: 'deactivated',
      keysDeactivated: result.keyIds.length,
      previousRole: membership.role,
      activeOrgRepointedTo: result.repointedTo,
    };
  }

  /**
   * Restores the membership. Deliberately restores NOTHING else: revoked keys
   * stay revoked (the user mints a new one) and old sessions stay dead. What
   * was cut on the way out is not silently re-armed on the way back.
   */
  async reactivateInOrganization(
    userId: string,
    organizationId: string,
    ctx: LifecycleContext,
  ): Promise<ReactivateResult> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true, deactivatedAt: true },
    });
    if (!membership) return { status: 'not_a_member' };
    if (!membership.deactivatedAt) return { status: 'already_active' };

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationMember.update({
        where: { userId_organizationId: { userId, organizationId } },
        data: { deactivatedAt: null },
      });
      // A user left with no active org is pointed back at this one.
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { organizationId: true },
      });
      if (user && user.organizationId === null) {
        await tx.user.update({
          where: { id: userId },
          data: { organizationId, role: membership.role },
        });
      }
    });

    await this.securityEvents.log({
      event: SecurityEvents.USER_REACTIVATED,
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      organizationId,
      targetUserId: userId,
      metadata: { reason: ctx.reason, providerId: ctx.providerId ?? null, role: membership.role },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { status: 'reactivated', role: membership.role };
  }

  /** For callers that render an "active" flag (SCIM). null = not a member. */
  async getMembershipState(userId: string, organizationId: string) {
    const m = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true, deactivatedAt: true },
    });
    if (!m) return null;
    return { active: m.deactivatedAt === null, role: m.role, deactivatedAt: m.deactivatedAt };
  }
}
