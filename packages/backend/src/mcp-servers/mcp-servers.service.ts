import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { KgSkillService } from '../knowledge-graph/kg-skill.service';
import { McpSessionManager } from './mcp-session.manager';

@Injectable()
export class McpServersService {
  private readonly logger = new Logger(McpServersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kgSkills: KgSkillService,
    private readonly sessionManager: McpSessionManager,
  ) {}

  async findAllByUser(userId: string) {
    return this.prisma.mcpServerConfig.findMany({
      where: { userId },
      include: {
        _count: { select: { connectors: true, apiKeys: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findAllByOrg(
    organizationId: string,
    opts?: { limit?: number; offset?: number },
  ) {
    return this.prisma.mcpServerConfig.findMany({
      where: { organizationId },
      include: {
        _count: { select: { connectors: true, apiKeys: true } },
      },
      orderBy: { createdAt: 'asc' },
      ...(opts?.limit !== undefined ? { take: opts.limit } : {}),
      ...(opts?.offset !== undefined ? { skip: opts.offset } : {}),
    });
  }

  /**
   * Tenant-isolation primitive: is the user a member of the organization?
   *
   * Authoritative membership check used by the per-server MCP endpoint. Unlike
   * comparing the single `users.organizationId` column, this honours
   * organization_members — so a user who belongs to multiple workspaces can
   * reach servers in any org they're actually a member of, while a non-member
   * is still denied (fail closed).
   */
  async isUserInOrganization(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    if (!userId || !organizationId) return false;
    const count = await this.prisma.organizationMember.count({
      where: { userId, organizationId, deactivatedAt: null },
    });
    return count > 0;
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
    // A slug derived from the name is ours to choose, so pick a free one
    // ("sales", "sales-2", …). A slug the user typed is theirs: if it is
    // taken, say so instead of renaming it behind their back.
    const slug = data.slug || (await this.freeSlug(organizationId, this.generateSlug(data.name)));
    return this.withSlugConflict(slug, () =>
      this.prisma.mcpServerConfig.create({
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
      }),
    );
  }

  async update(id: string, data: { name?: string; slug?: string; description?: string; instructions?: string; isActive?: boolean }) {
    return this.withSlugConflict(data.slug, () =>
      this.prisma.mcpServerConfig.update({
        where: { id },
        data,
        include: {
          _count: { select: { connectors: true, apiKeys: true } },
        },
      }),
    );
  }

  /** `base`, or `base-2`, `base-3`, … whichever is not taken in the organization. */
  private async freeSlug(organizationId: string, base: string): Promise<string> {
    const taken = new Set(
      (
        await this.prisma.mcpServerConfig.findMany({
          where: { organizationId, slug: { startsWith: base } },
          select: { slug: true },
        })
      ).map((s) => s.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * The (organization, slug) unique index is the source of truth. Two servers
   * with the same slug surfaced as a Prisma P2002 and a 500
   * (ANYTHINGMCP-CLOUD-BACKEND-4); it is the user's input, so it is a 409 the
   * dashboard can show.
   */
  private async withSlugConflict<T>(slug: string | undefined, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err: any) {
      const target = String(err?.meta?.target ?? err?.message ?? '');
      if (err?.code === 'P2002' && /slug/.test(target)) {
        throw new ConflictException(
          `An MCP server with the slug "${slug ?? ''}" already exists in this organization. Choose another slug.`,
        );
      }
      throw err;
    }
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

    // A server's connector assignment changed: live stateful sessions must
    // pick up added/removed tools. Fire-and-forget; never fail the assignment.
    this.sessionManager
      .notifyToolsChanged()
      .catch((e) =>
        this.logger.warn(`MCP session notify failed: ${e.message}`),
      );
  }

  /**
   * Attach one connector to the user's default server, additively.
   *
   * Distinct from {@link assignConnectors}, which replaces the whole set — the
   * caller here is connector creation, and a new connector must never silently
   * detach the ones already on the server.
   *
   * Returns the server it attached to, or null when there is nothing sensible
   * to attach to. Never throws: a connector that exists but is not wired up is
   * recoverable in the UI, a failed creation is not.
   */
  async attachToDefaultServer(
    userId: string,
    organizationId: string,
    connectorId: string,
  ): Promise<{ id: string; name: string } | null> {
    try {
      const server = await this.prisma.mcpServerConfig.findFirst({
        where: { userId, organizationId, isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });
      if (!server) return null;

      await this.prisma.mcpServerConnector.create({
        data: { mcpServerId: server.id, connectorId },
      });

      this.sessionManager
        .notifyToolsChanged()
        .catch((e) =>
          this.logger.warn(`MCP session notify failed: ${e.message}`),
        );

      return server;
    } catch (e: any) {
      // P2002 = already attached. Creation is retried often enough (import,
      // re-import, catalog resync) that this is expected, not a fault.
      if (e?.code !== 'P2002') {
        this.logger.warn(
          `Could not attach connector ${connectorId} to a default server: ${e?.message}`,
        );
      }
      return null;
    }
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

    // Compose applied skills (server-scoped + this server's connector-scoped)
    // dynamically, so editing/deleting a skill takes effect immediately.
    const skillsText = await this.kgSkills.activeSkillsText(
      serverId,
      serverConnectors.map((sc) => sc.connectorId),
    );
    if (skillsText) parts.push(skillsText);

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
    // `default`, then `default-<name>`, then `default-<name>-2`… Two members
    // with the same display name used to collide on the second one, and the
    // unique (org, slug) index turned their sign-up into a 500.
    const base = `default-${this.generateSlug(userLabel)}`;
    const candidates = ['default', base];
    for (let n = 2; n <= 50; n++) candidates.push(`${base}-${n}`);
    const taken = new Set(
      (
        await this.prisma.mcpServerConfig.findMany({
          where: { organizationId, slug: { in: candidates } },
          select: { slug: true },
        })
      ).map((r) => r.slug),
    );
    const slug =
      candidates.find((c) => !taken.has(c)) ?? `${base}-${userId.slice(-6).toLowerCase()}`;

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
