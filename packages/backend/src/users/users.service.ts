import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { User, UserRole } from '../generated/prisma/client';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

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

  async findAll(organizationId?: string) {
    return this.prisma.user.findMany({
      where: organizationId ? { organizationId } : undefined,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        organizationId: true,
        mcpRoleId: true,
        mcpRole: { select: { id: true, name: true } },
        createdAt: true,
        updatedAt: true,
      },
    });
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

  async deleteInOrg(userId: string, organizationId: string): Promise<boolean> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true },
    });
    if (!target) return false;
    await this.prisma.user.delete({ where: { id: userId } });
    return true;
  }

  async deleteSelf(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const adminMemberships = await this.prisma.organizationMember.findMany({
      where: { userId, role: 'ADMIN' },
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
        where: { organizationId: m.organizationId, role: 'ADMIN', userId: { not: userId } },
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
