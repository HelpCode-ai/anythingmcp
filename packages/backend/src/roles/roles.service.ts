import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(organizationId?: string) {
    return this.prisma.role.findMany({
      where: organizationId
        ? { OR: [{ organizationId }, { isSystem: true }] }
        : undefined,
      include: {
        _count: { select: { users: true, toolAccess: true } },
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.role.findUnique({
      where: { id },
      include: {
        toolAccess: {
          include: { tool: { select: { id: true, name: true, connector: { select: { name: true } } } } },
        },
        _count: { select: { users: true } },
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
        _count: { select: { users: true } },
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
   * Get the list of tool IDs a user is allowed to use.
   * Returns null if user has unrestricted access (no role assigned or ADMIN).
   */
  async getAllowedToolIds(userId: string): Promise<string[] | null> {
    // The MCP OAuth JWT sets `sub` to the user's email/username (not the DB UUID).
    // Try lookup by ID first, then fall back to email.
    let user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, mcpRoleId: true },
    });

    if (!user) {
      user = await this.prisma.user.findUnique({
        where: { email: userId },
        select: { role: true, mcpRoleId: true },
      });
    }

    if (!user) return [];

    // ADMIN always has full access
    if (user.role === 'ADMIN') return null;

    // No custom role = full access (backward compat)
    if (!user.mcpRoleId) return null;

    // Get tools assigned to this role
    const access = await this.prisma.toolRoleAccess.findMany({
      where: { roleId: user.mcpRoleId },
      select: { toolId: true },
    });

    return access.map((a) => a.toolId);
  }

  // ── User role assignment ──────────────────────────────────────────────────

  async assignRoleToUser(
    userId: string,
    roleId: string | null,
    organizationId: string,
  ) {
    // The user must belong to the requesting org, and the role must be
    // visible to that org (system roles or org-owned). Otherwise an admin
    // could assign someone else's user a role from their own org.
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true },
    });
    if (!user) return null;

    if (roleId !== null) {
      const role = await this.prisma.role.findFirst({
        where: {
          id: roleId,
          OR: [{ organizationId }, { isSystem: true }],
        },
        select: { id: true },
      });
      if (!role) return null;
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { mcpRoleId: roleId },
    });
  }

  // ── Seed system roles ─────────────────────────────────────────────────────

  async ensureSystemRoles() {
    const systemRoles = [
      { name: 'Full Access', description: 'Unrestricted access to all MCP tools' },
    ];

    for (const role of systemRoles) {
      const existing = await this.prisma.role.findFirst({
        where: { name: role.name, isSystem: true },
      });
      if (!existing) {
        await this.prisma.role.create({
          data: { ...role, isSystem: true },
        });
      }
    }
  }
}
