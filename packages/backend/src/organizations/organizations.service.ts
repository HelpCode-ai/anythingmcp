import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { UserRole } from '../generated/prisma/client';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId },
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
    if (!membership) {
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

  async removeMember(userId: string, organizationId: string) {
    await this.prisma.organizationMember.delete({
      where: { userId_organizationId: { userId, organizationId } },
    });

    // If this was the user's active org, switch to another
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.organizationId === organizationId) {
      const remaining = await this.prisma.organizationMember.findFirst({
        where: { userId },
        orderBy: { joinedAt: 'asc' },
      });
      if (remaining) {
        await this.switchOrg(userId, remaining.organizationId);
      }
    }
  }

  async updateMemberRole(userId: string, organizationId: string, role: UserRole) {
    const membership = await this.prisma.organizationMember.update({
      where: { userId_organizationId: { userId, organizationId } },
      data: { role },
    });

    // Sync cache if this is the user's active org
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.organizationId === organizationId) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { role },
      });
    }

    return membership;
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
