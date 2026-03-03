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

  async create(userId: string, data: { name: string; slug?: string; description?: string }) {
    const slug = data.slug || this.generateSlug(data.name);
    return this.prisma.mcpServerConfig.create({
      data: {
        userId,
        name: data.name,
        slug,
        description: data.description,
      },
      include: {
        _count: { select: { connectors: true, apiKeys: true } },
      },
    });
  }

  async update(id: string, data: { name?: string; slug?: string; description?: string; isActive?: boolean }) {
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

  async createDefaultForUser(userId: string) {
    // Check if user already has a default server (idempotent)
    const existing = await this.prisma.mcpServerConfig.findFirst({
      where: { userId, slug: 'default' },
    });
    if (existing) return existing;

    return this.prisma.mcpServerConfig.create({
      data: {
        userId,
        name: 'Default',
        slug: 'default',
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
