import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { Prisma, UserRole } from '../generated/prisma/client';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { LastAdminConflictException } from './last-admin.exception';

/** Ordered least- to most-privileged; used to tell a demotion from a promotion. */
const ORG_ROLE_RANK: Record<UserRole, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3 };

export interface MemberActionContext {
  actorUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async create(name: string) {
    return this.prisma.organization.create({
      data: { name },
    });
  }

  async findById(id: string) {
    return this.prisma.organization.findUnique({ where: { id } });
  }

  async update(id: string, data: { name?: string }) {
    return this.prisma.organization.update({ where: { id }, data });
  }

  async listUserOrgs(userId: string) {
    // Deactivated memberships are not offered as switch targets: the switch
    // would be refused anyway, and listing them would advertise a workspace
    // the user can no longer enter.
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId, deactivatedAt: null },
      include: {
        organization: { select: { id: true, name: true, createdAt: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      role: m.role,
      joinedAt: m.joinedAt,
      createdAt: m.organization.createdAt,
    }));
  }

  async getMembership(userId: string, organizationId: string) {
    return this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
  }

  async switchOrg(userId: string, organizationId: string) {
    const membership = await this.getMembership(userId, organizationId);
    if (!membership || membership.deactivatedAt) {
      throw new ForbiddenException('Not a member of this organization');
    }

    // Update the cached active org and role on the User record
    return this.prisma.user.update({
      where: { id: userId },
      data: { organizationId, role: membership.role },
    });
  }

  async addMember(userId: string, organizationId: string, role: UserRole = 'EDITOR' as UserRole) {
    return this.prisma.organizationMember.create({
      data: { userId, organizationId, role },
    });
  }

  /**
   * Removes ONE membership. Refuses to remove the last active admin.
   *
   * Callers wanting "the user loses access" should prefer
   * `UserLifecycleService.deactivateInOrganization`, which also revokes
   * sessions and MCP keys; this is the destructive follow-up.
   */
  async removeMember(userId: string, organizationId: string) {
    await this.assertNotLastAdmin(organizationId, userId);
    await this.prisma.organizationMember.delete({
      where: { userId_organizationId: { userId, organizationId } },
    });

    // If this was the user's active org, point the cache at another ACTIVE
    // membership — or at nothing. Leaving it at the removed org would keep a
    // fully working dashboard session for a workspace the user is no longer in,
    // because the JWT strategy reads the active org from this column.
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.organizationId === organizationId) {
      const remaining = await this.prisma.organizationMember.findFirst({
        where: { userId, deactivatedAt: null },
        orderBy: { joinedAt: 'asc' },
      });
      await this.prisma.user.update({
        where: { id: userId },
        data: remaining
          ? { organizationId: remaining.organizationId, role: remaining.role }
          : { organizationId: null },
      });
    }
  }

  /**
   * Throws `LastAdminConflictException` if `userId` is currently an ACTIVE
   * admin of the organization and no other active admin exists. A no-op for
   * anyone who is not an active admin. Accepts a transaction client so callers
   * can hold the row inside their own transaction.
   *
   * Deactivated admins do not count: a workspace whose only other admin has
   * been deactivated has, for every practical purpose, no other admin.
   */
  async assertNotLastAdmin(
    organizationId: string,
    userId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const target = await db.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true, deactivatedAt: true },
    });
    if (!target || target.role !== 'ADMIN' || target.deactivatedAt) return;

    const others = await db.organizationMember.count({
      where: { organizationId, role: 'ADMIN', deactivatedAt: null, userId: { not: userId } },
    });
    if (others === 0) throw new LastAdminConflictException(organizationId);
  }

  /**
   * Changes a member's role in ONE organization.
   *
   * Writes the membership row — the authoritative role — and refreshes the
   * `users.role` cache only when this is the user's active organization. The
   * previous implementation of the admin endpoint wrote the cache alone, which
   * left a demoted admin with membership.role = ADMIN and therefore with
   * unrestricted MCP tool access: `getAllowedToolIds` reads the membership.
   *
   * A DEMOTION also revokes every existing session (`sessionsValidFrom`): a
   * token minted while the user was an admin must not keep admin power until
   * it expires. A promotion only widens, so it revokes nothing.
   *
   * Returns null when the user is not a member (the controller's 404).
   */
  async updateMemberRole(
    userId: string,
    organizationId: string,
    role: UserRole,
    ctx: MemberActionContext,
  ): Promise<{ from: UserRole; to: UserRole; sessionsRevoked: boolean } | null> {
    const membership = await this.getMembership(userId, organizationId);
    if (!membership) return null;
    const from = membership.role;
    if (from === role) return { from, to: role, sessionsRevoked: false };

    const demotion = ORG_ROLE_RANK[from] > ORG_ROLE_RANK[role];

    await this.prisma.$transaction(async (tx) => {
      if (from === 'ADMIN' && demotion) {
        await this.assertNotLastAdmin(organizationId, userId, tx);
      }
      await tx.organizationMember.update({
        where: { userId_organizationId: { userId, organizationId } },
        data: { role },
      });
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { organizationId: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: {
          ...(user?.organizationId === organizationId ? { role } : {}),
          ...(demotion ? { sessionsValidFrom: new Date() } : {}),
        },
      });
    });

    await this.securityEvents.log({
      event: SecurityEvents.ROLE_CHANGED,
      actorType: 'USER',
      organizationId,
      actorUserId: ctx.actorUserId,
      targetUserId: userId,
      metadata: { from, to: role, via: 'admin' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (demotion) {
      await this.securityEvents.log({
        event: SecurityEvents.SESSIONS_REVOKED,
        actorType: 'USER',
        organizationId,
        actorUserId: ctx.actorUserId,
        targetUserId: userId,
        metadata: { reason: 'role_demotion', organizationId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return { from, to: role, sessionsRevoked: demotion };
  }

  async deleteOrganization(
    userId: string,
    organizationId: string,
    confirmName: string,
  ): Promise<{
    activeUser: { id: string; email: string; name: string | null; role: UserRole; organizationId: string; mcpRoleId: string | null };
    activeOrganization: { id: string; name: string };
    autoCreated: boolean;
  }> {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');

    if (org.name.trim() !== confirmName.trim()) {
      throw new BadRequestException('Confirmation name does not match');
    }

    const membership = await this.getMembership(userId, organizationId);
    if (!membership || membership.role !== 'ADMIN' || membership.deactivatedAt) {
      throw new ForbiddenException('Only org admins can delete the organization');
    }

    // Snapshot users (other than the deleter) whose CACHED active org is this one
    const orphans = await this.prisma.user.findMany({
      where: { organizationId, id: { not: userId } },
      select: { id: true },
    });

    type Next = { organizationId: string; role: UserRole } | null;
    const nextByOrphan = new Map<string, Next>();
    for (const o of orphans) {
      const m = await this.prisma.organizationMember.findFirst({
        where: { userId: o.id, organizationId: { not: organizationId }, deactivatedAt: null },
        orderBy: { joinedAt: 'asc' },
      });
      nextByOrphan.set(o.id, m ? { organizationId: m.organizationId, role: m.role } : null);
    }

    const selfNext = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId: { not: organizationId }, deactivatedAt: null },
      orderBy: { joinedAt: 'asc' },
    });

    let autoCreated = false;
    const finalUserId = userId;

    const result = await this.prisma.$transaction(async (tx) => {
      // Migrate orphans pre-cascade
      for (const [uid, next] of nextByOrphan.entries()) {
        if (next) {
          await tx.user.update({
            where: { id: uid },
            data: { organizationId: next.organizationId, role: next.role },
          });
        } else {
          await tx.user.update({
            where: { id: uid },
            data: { organizationId: null },
          });
        }
      }

      // Migrate the deleter
      if (selfNext) {
        await tx.user.update({
          where: { id: userId },
          data: { organizationId: selfNext.organizationId, role: selfNext.role },
        });
      } else {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
        const wsName = user?.name
          ? `${user.name}'s Workspace`
          : `${(user?.email ?? 'My').split('@')[0]}'s Workspace`;
        const newOrg = await tx.organization.create({ data: { name: wsName } });
        await tx.organizationMember.create({
          data: { userId, organizationId: newOrg.id, role: 'ADMIN' as UserRole },
        });
        await tx.user.update({
          where: { id: userId },
          data: { organizationId: newOrg.id, role: 'ADMIN' as UserRole },
        });
        autoCreated = true;
      }

      // Delete the organization — cascades clean up everything else
      await tx.organization.delete({ where: { id: organizationId } });

      const updatedUser = await tx.user.findUnique({ where: { id: finalUserId } });
      if (!updatedUser || !updatedUser.organizationId) {
        throw new Error('User active org missing after migration');
      }
      const activeOrg = await tx.organization.findUnique({
        where: { id: updatedUser.organizationId },
        select: { id: true, name: true },
      });
      if (!activeOrg) {
        throw new Error('Active organization missing after migration');
      }
      return {
        activeUser: {
          id: updatedUser.id,
          email: updatedUser.email,
          name: updatedUser.name,
          role: updatedUser.role,
          organizationId: updatedUser.organizationId,
          mcpRoleId: updatedUser.mcpRoleId,
        },
        activeOrganization: activeOrg,
      };
    });

    return { ...result, autoCreated };
  }

  async getMembers(organizationId: string) {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { organizationId },
      include: {
        user: { select: { id: true, email: true, name: true, mcpRoleId: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      mcpRoleId: m.user.mcpRoleId,
      joinedAt: m.joinedAt,
    }));
  }
}
