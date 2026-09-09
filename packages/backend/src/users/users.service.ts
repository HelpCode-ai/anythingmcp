import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { User, UserRole } from '../generated/prisma/client';
import { OrganizationsService } from '../organizations/organizations.service';
import { UserLifecycleService, LifecycleContext } from './user-lifecycle.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly lifecycle: UserLifecycleService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async create(data: {
    email: string;
    passwordHash: string;
    name: string;
    role?: UserRole;
    organizationId: string;
  }): Promise<User> {
    return this.prisma.user.create({ data });
  }

  async count(): Promise<number> {
    return this.prisma.user.count();
  }

  /**
   * Members of an organization, from `organization_members`.
   *
   * Previously read `users.organization_id`, which is only the ACTIVE-org
   * cache: a person who belongs to several workspaces was invisible to the
   * admins of every workspace but the one they last switched to. `role` is
   * the membership role — the one authorization actually uses.
   */
  async findAll(organizationId: string) {
    const rows = await this.prisma.organizationMember.findMany({
      where: { organizationId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            mcpRoleId: true,
            mcpRole: { select: { id: true, name: true } },
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      organizationId,
      mcpRoleId: m.user.mcpRoleId,
      mcpRole: m.user.mcpRole,
      createdAt: m.user.createdAt,
      updatedAt: m.user.updatedAt,
      joinedAt: m.joinedAt,
      deactivatedAt: m.deactivatedAt,
      active: m.deactivatedAt === null,
    }));
  }

  async update(userId: string, data: Partial<User>): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  /**
   * Read the fields the welcome wizard + drip cron care about.
   * Lightweight — picks only the relevant columns, no joins.
   */
  async getOnboardingState(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        emailVerified: true,
        createdAt: true,
        onboardingCompletedAt: true,
        onboardingLastReminderAt: true,
        onboardingReminderCount: true,
        emailMarketingOptOut: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Mark the wizard finished/skipped or toggle the marketing opt-out flag.
   * Both fields are idempotent: setting completed=true twice keeps the
   * earliest timestamp (we don't overwrite a non-null value), so re-opening
   * the wizard later won't reset analytics.
   */
  async updateOnboardingState(
    userId: string,
    patch: { completed?: boolean; emailMarketingOptOut?: boolean },
  ) {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { onboardingCompletedAt: true },
    });
    if (!current) throw new NotFoundException('User not found');

    const data: Partial<User> = {};
    if (patch.completed === true && current.onboardingCompletedAt === null) {
      data.onboardingCompletedAt = new Date();
    }
    if (patch.emailMarketingOptOut !== undefined) {
      data.emailMarketingOptOut = patch.emailMarketingOptOut;
    }

    if (Object.keys(data).length === 0) return this.getOnboardingState(userId);

    await this.prisma.user.update({ where: { id: userId }, data });
    return this.getOnboardingState(userId);
  }

  /**
   * Update a user only if they belong to the given organization.
   * Returns null if no row matched. Use this from any admin endpoint
   * that takes a user id from the request URL.
   */
  async updateInOrg(
    userId: string,
    organizationId: string,
    data: Partial<User>,
  ): Promise<User | null> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, organizationId },
      data,
    });
    if (result.count === 0) return null;
    return this.prisma.user.findUnique({ where: { id: userId } });
  }

  async delete(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } });
  }

  /**
   * Removes a user from an organization, as that organization's admin.
   *
   * Keyed on the membership, not on the `users.organization_id` cache, and
   * scoped to what this admin actually owns: if the user also belongs to
   * other workspaces, only THIS membership goes (plus its keys and roles) and
   * the account survives. Deleting the global user row from here let the admin
   * of one workspace destroy someone's access to every other one.
   *
   * Returns false when the user is not a member (the controller's 404).
   * Throws LastAdminConflictException for the only active admin.
   */
  async deleteInOrg(
    userId: string,
    organizationId: string,
    ctx: LifecycleContext,
  ): Promise<boolean> {
    const membership = await this.prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { id: true },
    });
    if (!membership) return false;

    await this.organizations.assertNotLastAdmin(organizationId, userId);

    const otherMemberships = await this.prisma.organizationMember.count({
      where: { userId, organizationId: { not: organizationId } },
    });

    if (otherMemberships === 0) {
      // Sole workspace: the account has nowhere else to live. Cascade cleans
      // memberships, roles, keys and identities.
      await this.prisma.user.delete({ where: { id: userId } });
      return true;
    }

    // Cut access first (sessions, keys, cache repoint), then remove the rows.
    await this.lifecycle.deactivateInOrganization(userId, organizationId, ctx);
    await this.prisma.$transaction([
      this.prisma.userRoleAssignment.deleteMany({ where: { userId, organizationId } }),
      this.prisma.mcpApiKey.deleteMany({ where: { userId, organizationId } }),
      this.prisma.organizationMember.delete({
        where: { userId_organizationId: { userId, organizationId } },
      }),
    ]);
    await this.securityEvents.log({
      event: SecurityEvents.MEMBERSHIP_REMOVED,
      actorType: ctx.actor.type,
      actorUserId: ctx.actor.userId ?? null,
      organizationId,
      targetUserId: userId,
      metadata: { reason: ctx.reason, remainingMemberships: otherMemberships },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return true;
  }

  async deleteSelf(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const adminMemberships = await this.prisma.organizationMember.findMany({
      where: { userId, role: 'ADMIN', deactivatedAt: null },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            _count: { select: { members: true } },
          },
        },
      },
    });

    const blocking: { id: string; name: string }[] = [];
    const cascadableOrgIds: string[] = [];

    for (const m of adminMemberships) {
      const memberCount = m.organization._count.members;
      if (memberCount <= 1) {
        cascadableOrgIds.push(m.organizationId);
        continue;
      }
      const otherAdmins = await this.prisma.organizationMember.count({
        where: { organizationId: m.organizationId, role: 'ADMIN', deactivatedAt: null, userId: { not: userId } },
      });
      if (otherAdmins === 0) {
        blocking.push({ id: m.organization.id, name: m.organization.name });
      }
    }

    if (blocking.length > 0) {
      throw new ConflictException({
        error: 'You are the only admin of these organizations. Transfer admin or delete them before deleting your account.',
        blockingOrganizations: blocking,
      });
    }

    await this.prisma.$transaction([
      ...cascadableOrgIds.map((orgId) =>
        this.prisma.organization.delete({ where: { id: orgId } }),
      ),
      this.prisma.oAuthAuthorizationCode.deleteMany({ where: { userId } }),
      this.prisma.user.delete({ where: { id: userId } }),
    ]);
  }

  async findAllInvitations(organizationId?: string) {
    return this.prisma.invitationToken.findMany({
      where: { usedAt: null, ...(organizationId ? { organizationId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteInvitation(id: string): Promise<void> {
    await this.prisma.invitationToken.delete({ where: { id } });
  }

  async deleteInvitationInOrg(id: string, organizationId: string): Promise<boolean> {
    const result = await this.prisma.invitationToken.deleteMany({
      where: { id, organizationId },
    });
    return result.count > 0;
  }
}
