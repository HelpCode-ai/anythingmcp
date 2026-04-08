import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class McpServersService {
  private readonly logger = new Logger(McpServersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAllByUser(userId: string) {
    return this.prisma.mcpServerConfig.findMany({
      where: { userId },
      include: {
        _count: { select: { connectors: true, apiKeys: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findAllByOrg(organizationId: string) {
    return this.prisma.mcpServerConfig.findMany({
      where: { organizationId },
      include: {
        _count: { select: { connectors: true, apiKeys: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findById(id: string) {
    return this.prisma.mcpServerConfig.findUnique({
      where: { id },
      include: {
        connectors: {
          include: {
            connector: {
              select: { id: true, name: true, type: true, isActive: true },
            },
          },
        },
        apiKeys: {
          select: {
            id: true,
            name: true,
            key: true,
            isActive: true,
            lastUsedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { connectors: true, apiKeys: true } },
      },
    });
  }

  async create(userId: string, organizationId: string, data: { name: string; slug?: string; description?: string; instructions?: string }) {
    const slug = data.slug || this.generateSlug(data.name);
    return this.prisma.mcpServerConfig.create({
      data: {
        userId,
        organizationId,
        name: data.name,
        slug,
        description: data.description,
        instructions: data.instructions,
      },
      include: {
        _count: { select: { connectors: true, apiKeys: true } },
      },
    });
  }

  async update(id: string, data: { name?: string; slug?: string; description?: string; instructions?: string; isActive?: boolean }) {
    return this.prisma.mcpServerConfig.update({
      where: { id },
      data,
      include: {
        _count: { select: { connectors: true, apiKeys: true } },
      },
    });
  }

  async delete(id: string) {
    await this.prisma.mcpServerConfig.delete({ where: { id } });
  }

  async assignConnectors(serverId: string, connectorIds: string[]) {
    // Replace all: delete existing, insert new
    await this.prisma.$transaction([
      this.prisma.mcpServerConnector.deleteMany({
        where: { mcpServerId: serverId },
      }),
      ...connectorIds.map((connectorId) =>
        this.prisma.mcpServerConnector.create({
          data: { mcpServerId: serverId, connectorId },
        }),
      ),
    ]);
  }

  async getConnectorIds(serverId: string): Promise<string[]> {
    const rows = await this.prisma.mcpServerConnector.findMany({
      where: { mcpServerId: serverId },
      select: { connectorId: true },
    });
    return rows.map((r) => r.connectorId);
  }

  /**
   * Compose MCP server instructions from the server's own instructions
   * plus all assigned connectors' instructions.
   */
  async getComposedInstructions(serverId: string): Promise<string | undefined> {
    const server = await this.prisma.mcpServerConfig.findUnique({
      where: { id: serverId },
      select: { instructions: true },
    });

    const serverConnectors = await this.prisma.mcpServerConnector.findMany({
      where: { mcpServerId: serverId },
      include: {
        connector: {
          select: { name: true, instructions: true },
        },
      },
    });

    const parts: string[] = [];

    if (server?.instructions) {
      parts.push(server.instructions);
    }

    for (const sc of serverConnectors) {
      if (sc.connector.instructions) {
        parts.push(`## ${sc.connector.name}\n${sc.connector.instructions}`);
      }
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  async createDefaultForUser(userId: string, organizationId: string) {
    // Check if user already has a default server (idempotent)
    const existing = await this.prisma.mcpServerConfig.findFirst({
      where: { userId, slug: { startsWith: 'default' } },
    });
    if (existing) return existing;

    // Generate a unique slug within the org
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const userLabel = user?.name || user?.email?.split('@')[0] || userId.slice(-6);
    let slug = 'default';

    // Check if 'default' slug already exists in this org
    const slugExists = await this.prisma.mcpServerConfig.findFirst({
      where: { organizationId, slug: 'default' },
    });
    if (slugExists) {
      slug = `default-${this.generateSlug(userLabel)}`;
    }

    return this.prisma.mcpServerConfig.create({
      data: {
        userId,
        organizationId,
        name: `Default (${userLabel})`,
        slug,
      },
    });
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'server';
  }
}
