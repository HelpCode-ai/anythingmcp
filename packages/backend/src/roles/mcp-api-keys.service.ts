import { Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import { apiKeyLookupWhere, apiKeySuffix, hashApiKey } from '../common/crypto/api-key-hash.util';
import { isKeyExpired } from './support-keys';
import type { McpApiKeyScope } from '../generated/prisma/client';

@Injectable()
export class McpApiKeysService implements OnApplicationBootstrap {
  private readonly logger = new Logger(McpApiKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    // Fire-and-forget so a slow table never blocks boot. Idempotent, so two
    // containers running it during a blue/green release do no harm.
    void this.backfillKeyHashes().catch((err) =>
      this.logger.error(`API key hash backfill failed: ${err?.message ?? err}`),
    );
  }

  /**
   * Hash the keys created before `key_hash` existed. Returns how many rows
   * were updated. Never logs a key.
   */
  async backfillKeyHashes(batchSize = 500): Promise<number> {
    let updated = 0;
    for (;;) {
      const rows = await this.prisma.mcpApiKey.findMany({
        where: { keyHash: null },
        select: { id: true, key: true },
        take: batchSize,
      });
      if (rows.length === 0) break;
      let progressed = 0;
      for (const row of rows) {
        const res = await this.prisma.mcpApiKey.updateMany({
          where: { id: row.id, keyHash: null },
          data: { keyHash: hashApiKey(row.key), keySuffix: apiKeySuffix(row.key) },
        });
        progressed += res.count;
      }
      updated += progressed;
      // A short batch is the last one; a batch that changed nothing would be
      // read again forever (e.g. writes refused), so stop there too.
      if (rows.length < batchSize || progressed === 0) break;
    }
    if (updated > 0) this.logger.log(`Hashed ${updated} API key(s) created before key_hash existed`);
    return updated;
  }

  /**
   * Generate a new MCP API key for a user.
   * Key format: mcp_<64 hex chars> (32 random bytes, 256 bits).
   */
  async generate(
    userId: string,
    organizationId: string,
    name: string,
    mcpServerId?: string,
    scope: McpApiKeyScope = 'MCP',
  ) {
    // A key for a server is limited to that server, so the server must be one
    // the user can reach: an existing server of an organization they are an
    // active member of. Same answer whether it does not exist or is not
    // theirs. A key without a server (API only) is not affected.
    if (mcpServerId) {
      const server = await this.prisma.mcpServerConfig.findUnique({
        where: { id: mcpServerId },
        select: { organizationId: true },
      });
      const membership = server
        ? await this.prisma.organizationMember.findUnique({
            where: { userId_organizationId: { userId, organizationId: server.organizationId } },
            select: { deactivatedAt: true },
          })
        : null;
      if (!membership || membership.deactivatedAt) {
        throw new NotFoundException('MCP server not found');
      }
      // A server's key belongs to the server's workspace (resolveUserByKey
      // scopes a key to its organization), whichever workspace the owner
      // happened to be in when creating it.
      organizationId = server!.organizationId;
    }

    const key = `mcp_${randomBytes(32).toString('hex')}`;

    return this.prisma.mcpApiKey.create({
      data: {
        userId,
        organizationId,
        key,
        keyHash: hashApiKey(key),
        keySuffix: apiKeySuffix(key),
        name,
        mcpServerId: mcpServerId || null,
        scope,
      },
      select: { id: true, key: true, name: true, isActive: true, mcpServerId: true, scope: true, createdAt: true },
    });
  }

  async listByUser(userId: string) {
    return this.prisma.mcpApiKey.findMany({
      // Support keys are an operator's, not the user's (see support-keys.ts).
      where: { userId, isSupport: false },
      select: {
        id: true,
        name: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
        key: true,
        scope: true,
        mcpServerId: true,
        mcpServer: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(id: string, userId: string) {
    return this.prisma.mcpApiKey.updateMany({
      where: { id, userId, isSupport: false },
      data: { isActive: false },
    });
  }

  async deleteKey(id: string, userId: string) {
    return this.prisma.mcpApiKey.deleteMany({
      // A support key row is the audit record: never deleted from here.
      where: { id, userId, isSupport: false },
    });
  }

  /**
   * Resolve a user from an MCP API key.
   * Returns the user with their role info, or null if key is invalid/inactive.
   */
  async resolveUserByKey(apiKey: string) {
    const record = await this.prisma.mcpApiKey.findFirst({
      where: apiKeyLookupWhere(apiKey),
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            organizationId: true,
            mcpRoleId: true,
          },
        },
      },
    });

    if (!record || !record.isActive || isKeyExpired(record.expiresAt)) return null;

    // Defence in depth: a key is bound to one organization, and it must not
    // authenticate a user who has been deactivated there — even if the key row
    // itself somehow escaped deactivation.
    const membership = await this.prisma.organizationMember.findUnique({
      where: {
        userId_organizationId: { userId: record.userId, organizationId: record.organizationId },
      },
      select: { deactivatedAt: true, role: true },
    });
    if (!membership || membership.deactivatedAt) return null;

    // Update last used timestamp; hash a key that an older container created
    // after the boot backfill ran.
    await this.prisma.mcpApiKey.update({
      where: { id: record.id },
      data: {
        lastUsedAt: new Date(),
        ...(record.keyHash ? {} : { keyHash: hashApiKey(apiKey), keySuffix: apiKeySuffix(apiKey) }),
      },
    }).catch(() => {});

    // A key acts in the workspace it was created in, with the owner's role
    // THERE. `users.organization_id` / `users.role` describe the workspace the
    // owner last switched to in the dashboard, which can be another one: taking
    // them would let a key created for workspace A reach workspace B.
    const scoped = { ...record.user, organizationId: record.organizationId, role: membership.role };
    if (record.isSupport) {
      // No key name for a support key: it would reach the workspace's logs
      // and, through {{amcp.api_key_name}}, its connectors' target systems.
      return { ...scoped, mcpServerId: record.mcpServerId, apiKeyName: undefined, supportKeyId: record.id };
    }
    return { ...scoped, mcpServerId: record.mcpServerId, apiKeyName: record.name, supportKeyId: undefined };
  }
}
