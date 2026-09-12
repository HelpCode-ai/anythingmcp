import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * What a grant resolved to, for the caller that is about to build a tool list.
 *
 * `null` from {@link McpConnectionGrantService.resolve} and `{ mode: 'none' }`
 * mean very different things and must not be collapsed:
 *
 * - `null` — this client has **no** grant. Every token issued before grants
 *   existed is in this bucket, so the caller keeps the previous behaviour
 *   (the caller's active organization) and nothing regresses.
 * - `{ mode: 'none' }` — a grant exists and **nothing in it survived
 *   validation**: the servers were deleted, deactivated, or belong to an
 *   organization this user is no longer a member of. That is zero tools, never
 *   "fall back to everything".
 */
export type ResolvedGrant =
  | { mode: 'organization'; organizationId: string }
  | { mode: 'servers'; servers: { id: string; organizationId: string }[] }
  | { mode: 'none' };

/**
 * The user's selection of what an OAuth client may see through the shared
 * `/mcp` endpoint.
 *
 * The one rule everything here follows: **a grant can only ever narrow what the
 * user is already entitled to.** It is applied after authorization, never
 * instead of it. Concretely —
 *
 * - Stored ids are never trusted. A target's owning organization is read back
 *   from `mcp_server_configs`, and membership is re-checked, on every
 *   resolution. A grant is written when a token is issued; membership can be
 *   revoked hours later, and the token stays valid until it expires.
 * - Validation is expressed as a SQL join rather than a loop with an `if`, so
 *   a target the user cannot reach cannot be returned by construction.
 * - Anything unresolvable is dropped silently. The caller must not be able to
 *   tell "no such server" from "not your server" — that difference would
 *   confirm the existence of another tenant's server.
 */
@Injectable()
export class McpConnectionGrantService {
  private readonly logger = new Logger(McpConnectionGrantService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve what `clientId` may see on behalf of `userId`, re-validating every
   * target. See {@link ResolvedGrant} for why `null` and `{ mode: 'none' }` are
   * distinct.
   */
  async resolve(
    clientId: string | undefined,
    userId: string | undefined,
  ): Promise<ResolvedGrant | null> {
    if (!clientId || !userId) return null;

    const grant = await this.prisma.mcpConnectionGrant.findUnique({
      where: { clientId_userId: { clientId, userId } },
      select: { organizationId: true, serverIds: true, revokedAt: true },
    });
    if (!grant) return null;

    // Revoked from the dashboard. Not the same as absent: absent means the
    // client was connected before grants existed and keeps the old behaviour,
    // revoked means the user asked for this connection to stop seeing things.
    if (grant.revokedAt) return { mode: 'none' };

    if (grant.organizationId) {
      const stillAMember = await this.isMember(userId, grant.organizationId);
      return stillAMember
        ? { mode: 'organization', organizationId: grant.organizationId }
        : { mode: 'none' };
    }

    const servers = await this.validateServers(userId, grant.serverIds);
    return servers.length > 0 ? { mode: 'servers', servers } : { mode: 'none' };
  }

  /**
   * Grant the whole of one workspace — every tool of that organization, which
   * is what `/mcp` served before grants existed. Refuses when the user is not a
   * member, so a forged form value cannot mint access to another tenant.
   */
  async grantWholeOrganization(
    clientId: string,
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    if (!(await this.isMember(userId, organizationId))) {
      this.logger.warn(
        `Refused whole-workspace grant: user ${userId} is not a member of ${organizationId}`,
      );
      return false;
    }
    await this.upsert(clientId, userId, { organizationId, serverIds: [] });
    return true;
  }

  /**
   * Grant a specific set of MCP servers. Ids the user cannot reach are dropped;
   * if nothing is left the grant is not written at all, so a caller cannot turn
   * an entirely invalid selection into a stored empty grant.
   *
   * Returns the ids actually granted.
   */
  async grantServers(
    clientId: string,
    userId: string,
    serverIds: string[],
  ): Promise<string[]> {
    const valid = await this.validateServers(userId, serverIds);
    const dropped = serverIds.length - valid.length;
    if (dropped > 0) {
      this.logger.warn(
        `Dropped ${dropped} unreachable server id(s) from a grant for user ${userId}`,
      );
    }
    if (valid.length === 0) return [];

    await this.upsert(clientId, userId, {
      organizationId: null,
      serverIds: valid.map((s) => s.id),
    });
    return valid.map((s) => s.id);
  }

  /**
   * Stop a client seeing anything, without deleting the row.
   *
   * Deleting would read back as "no grant", which is the pre-grant behaviour —
   * the caller's whole organization. A revoke has to narrow, so it stamps
   * `revokedAt` and leaves the rest in place; choosing again clears it.
   *
   * Returns false when there was nothing to revoke.
   */
  async revoke(clientId: string, userId: string): Promise<boolean> {
    const { count } = await this.prisma.mcpConnectionGrant.updateMany({
      where: { clientId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * The workspaces this user belongs to and the MCP servers in each — what a
   * picker may offer, and nothing else.
   *
   * Membership is the query, not a filter applied afterwards, for the same
   * reason as {@link validateServers}: a workspace the user does not belong to
   * cannot appear in the result at all, so it cannot be offered and then
   * accidentally accepted.
   */
  async listSelectableTargets(userId: string): Promise<
    {
      organizationId: string;
      organizationName: string;
      servers: { id: string; name: string; connectorCount: number }[];
    }[]
  > {
    if (!userId) return [];

    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId, deactivatedAt: null },
      select: {
        organization: {
          select: {
            id: true,
            name: true,
            mcpServers: {
              where: { isActive: true },
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                name: true,
                _count: { select: { connectors: true } },
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((m) => ({
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      servers: m.organization.mcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        connectorCount: s._count.connectors,
      })),
    }));
  }

  /** Everything this user has granted, for the dashboard's revoke list. */
  async listForUser(userId: string) {
    return this.prisma.mcpConnectionGrant.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: {
        clientId: true,
        organizationId: true,
        serverIds: true,
        revokedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * The servers out of `serverIds` that this user can actually reach, with the
   * organization each one really belongs to.
   *
   * Membership is part of the WHERE clause on purpose: there is no code path
   * where a row comes back and a separate check is then expected to reject it.
   * Deactivated members (`deactivatedAt`) and inactive servers are excluded on
   * the same terms as the per-server endpoint.
   */
  private async validateServers(
    userId: string,
    serverIds: string[],
  ): Promise<{ id: string; organizationId: string }[]> {
    const ids = [...new Set(serverIds.filter((id) => !!id))];
    if (ids.length === 0) return [];

    return this.prisma.mcpServerConfig.findMany({
      where: {
        id: { in: ids },
        isActive: true,
        organization: {
          members: { some: { userId, deactivatedAt: null } },
        },
      },
      select: { id: true, organizationId: true },
    });
  }

  private async isMember(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const count = await this.prisma.organizationMember.count({
      where: { userId, organizationId, deactivatedAt: null },
    });
    return count > 0;
  }

  private async upsert(
    clientId: string,
    userId: string,
    data: { organizationId: string | null; serverIds: string[] },
  ): Promise<void> {
    await this.prisma.mcpConnectionGrant.upsert({
      where: { clientId_userId: { clientId, userId } },
      create: { clientId, userId, ...data },
      // Choosing again un-revokes: the user is explicitly saying what this
      // client may reach, which is the opposite of having revoked it.
      update: { ...data, revokedAt: null },
    });
  }
}
