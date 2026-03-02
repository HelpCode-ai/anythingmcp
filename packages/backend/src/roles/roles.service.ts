import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.role.findMany({
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

  async create(data: { name: string; description?: string }) {
    return this.prisma.role.create({
      data: { name: data.name, description: data.description },
    });
  }

  async update(id: string, data: { name?: string; description?: string }) {
    return this.prisma.role.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    // Unassign users first
    await this.prisma.user.updateMany({
      where: { mcpRoleId: id },
      data: { mcpRoleId: null },
    });
    await this.prisma.role.delete({ where: { id } });
  }

  // ── Tool access management ────────────────────────────────────────────────

  async getToolAccess(roleId: string) {
    return this.prisma.toolRoleAccess.findMany({
      where: { roleId },
      include: { tool: { select: { id: true, name: true, description: true, connector: { select: { id: true, name: true } } } } },
    });
  }

  async setToolAccess(roleId: string, toolIds: string[]) {
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

  async assignRoleToUser(userId: string, roleId: string | null) {
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
      await this.prisma.role.upsert({
        where: { name: role.name },
        create: { ...role, isSystem: true },
        update: {},
      });
    }
  }
}
