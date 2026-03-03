import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class McpApiKeysService {
  private readonly logger = new Logger(McpApiKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a new MCP API key for a user.
   * Key format: mcp_<32 random hex chars>
   */
  async generate(userId: string, name: string, mcpServerId?: string) {
    const key = `mcp_${randomBytes(32).toString('hex')}`;

    return this.prisma.mcpApiKey.create({
      data: { userId, key, name, mcpServerId: mcpServerId || null },
      select: { id: true, key: true, name: true, isActive: true, mcpServerId: true, createdAt: true },
    });
  }

  async listByUser(userId: string) {
    return this.prisma.mcpApiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        key: true,
        mcpServerId: true,
        mcpServer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(id: string, userId: string) {
    return this.prisma.mcpApiKey.updateMany({
      where: { id, userId },
      data: { isActive: false },
    });
  }

  async deleteKey(id: string, userId: string) {
    return this.prisma.mcpApiKey.deleteMany({
      where: { id, userId },
    });
  }

  /**
   * Resolve a user from an MCP API key.
   * Returns the user with their role info, or null if key is invalid/inactive.
   */
  async resolveUserByKey(apiKey: string) {
    const record = await this.prisma.mcpApiKey.findUnique({
      where: { key: apiKey },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            mcpRoleId: true,
          },
        },
      },
    });

    if (!record || !record.isActive) return null;

    // Update last used timestamp
    await this.prisma.mcpApiKey.update({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {});

    return { ...record.user, mcpServerId: record.mcpServerId };
  }
}
