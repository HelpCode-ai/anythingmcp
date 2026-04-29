import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
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
    if (!membership || membership.role !== 'ADMIN') {
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
        where: { userId: o.id, organizationId: { not: organizationId } },
        orderBy: { joinedAt: 'asc' },
      });
      nextByOrphan.set(o.id, m ? { organizationId: m.organizationId, role: m.role } : null);
    }

    const selfNext = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId: { not: organizationId } },
      orderBy: { joinedAt: 'asc' },
    });

    let autoCreated = false;
    let finalUserId = userId;

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
