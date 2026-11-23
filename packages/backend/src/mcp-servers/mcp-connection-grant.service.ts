import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import {
  MemberVisibilityService,
  connectorWhere,
  serverWhere,
  type VisibilityScope,
} from '../settings/member-visibility.service';

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
 * `/mcp` endpoint, and which servers it may open by their own URL
 * (`/mcp/<serverId>`, see {@link McpConnectionGrantService.serverScope}).
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
const REDIRECT_URI_CACHE_MAX = 10_000;

/**
 * `MCP_GRANT_SERVER_SCOPE`: whether a connection grant also limits which
 * servers the client opens by their own URL (`/mcp/<serverId>`).
 * `enforce` (default) refuses a server outside the grant, `report` only logs
 * what would be refused, `off` does neither. Read on every request, so
 * changing it needs a restart but no new build.
 */
export type GrantServerScopeMode = 'enforce' | 'report' | 'off';

export function grantServerScopeMode(
  value: string | undefined = process.env.MCP_GRANT_SERVER_SCOPE,
): GrantServerScopeMode {
  const mode = (value ?? '').trim().toLowerCase();
  return mode === 'report' || mode === 'off' ? mode : 'enforce';
}

/**
 * What a client's grant says about one server opened by its own URL.
 *
 * - `no-grant`: the client has no grant row (tokens from before grants
 *   existed, the SSO sign-in). Nothing to apply.
 * - `granted`: the grant names the server, or its whole workspace.
 * - `outside`: the grant does not include the server.
 * - `revoked`: the user revoked this connection.
 * - `not-grantable`: outside the grant, and the user could not add it by
 *   authorizing again, because member visibility hides the server from them
 *   (see {@link McpConnectionGrantService.grantRequestedServer}).
 */
export type ServerScope = 'no-grant' | 'granted' | 'outside' | 'revoked' | 'not-grantable';

/** The fields of a grant row that decide a {@link ServerScope}. */
type GrantRow = { organizationId: string | null; serverIds: string[]; revokedAt: Date | null };

const GRANT_ROW_CACHE_TTL_MS = 60_000;
const GRANT_ROW_CACHE_MAX = 20_000;

function scopeOf(
  row: GrantRow | null,
  server: { id: string; organizationId?: string | null },
): Exclude<ServerScope, 'not-grantable'> {
  if (!row) return 'no-grant';
  if (row.revokedAt) return 'revoked';
  if (row.organizationId) {
    return row.organizationId === server.organizationId ? 'granted' : 'outside';
  }
  return row.serverIds.includes(server.id) ? 'granted' : 'outside';
}

@Injectable()
export class McpConnectionGrantService {
  private readonly logger = new Logger(McpConnectionGrantService.name);
  private readonly redirectUrisByClient = new Map<string, string[]>();
  /** Grant rows by client and user, for {@link serverScope}. */
  private readonly grantRows = new Map<string, { row: GrantRow | null; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly events?: ProductEventService,
    // Not @Optional: Nest refuses to boot without it. It is missing only in
    // unit specs that build the service by hand and predate the setting.
    private readonly visibility?: MemberVisibilityService,
  ) {}

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
   * What the grant of `clientId` for `userId` says about one server opened by
   * its own URL. The caller has already checked that the server is active and
   * that the user is a member of its workspace, so only the grant row is read.
   *
   * The row is cached for a minute, because `/mcp/<serverId>` is called far
   * more often than a grant changes. A cached row is only trusted to let a
   * request through: before a refusal the row is read again, so a grant that
   * was just extended (possibly by another process) takes effect at once and a
   * client never loops on a stale refusal. The other way round, a revoke or a
   * narrowed grant can take up to a minute to apply here on another process;
   * this process forgets the row on every write.
   */
  async serverScope(
    clientId: string | undefined,
    userId: string | undefined,
    server: { id: string; organizationId?: string | null },
  ): Promise<ServerScope> {
    if (!clientId || !userId) return 'no-grant';

    const cached = this.grantRows.get(this.grantRowKey(clientId, userId));
    if (cached && cached.expiresAt > Date.now()) {
      const scope = scopeOf(cached.row, server);
      if (scope === 'no-grant' || scope === 'granted') return scope;
    }

    const scope = scopeOf(await this.readGrantRow(clientId, userId), server);
    if (scope !== 'outside') return scope;

    // Outside the grant. Authorizing again adds the server, unless member
    // visibility hides it from this user: then nothing they do could fix a
    // refusal, and the caller keeps the server reachable as before.
    if (server.organizationId) {
      const visible = await this.keepVisible(userId, [
        { id: server.id, organizationId: server.organizationId },
      ]);
      if (visible.length === 0) return 'not-grantable';
    }
    return 'outside';
  }

  /** {@link serverScope} for a caller that only has the server's id (the refresh grant). */
  async serverScopeById(
    clientId: string | undefined,
    userId: string | undefined,
    serverId: string,
  ): Promise<ServerScope> {
    if (!clientId || !userId || !serverId) return 'no-grant';
    const server = await this.prisma.mcpServerConfig.findUnique({
      where: { id: serverId },
      select: { id: true, organizationId: true },
    });
    // An unknown server is the endpoint's 404, not a grant question.
    if (!server) return 'no-grant';
    return this.serverScope(clientId, userId, server);
  }

  private grantRowKey(clientId: string, userId: string): string {
    return `${clientId}\n${userId}`;
  }

  private async readGrantRow(clientId: string, userId: string): Promise<GrantRow | null> {
    const row = await this.prisma.mcpConnectionGrant.findUnique({
      where: { clientId_userId: { clientId, userId } },
      select: { organizationId: true, serverIds: true, revokedAt: true },
    });
    if (this.grantRows.size >= GRANT_ROW_CACHE_MAX) this.grantRows.clear();
    this.grantRows.set(this.grantRowKey(clientId, userId), {
      row: row ?? null,
      expiresAt: Date.now() + GRANT_ROW_CACHE_TTL_MS,
    });
    return row ?? null;
  }

  /**
   * Grant the one server a client asked for by its URL (RFC 8707 `resource`).
   *
   * A client registration can be used for more than one server URL, and each
   * URL runs its own authorization. Replacing the grant every time would leave
   * only the last server, and the earlier URLs would be refused. So the server
   * is ADDED to what the user already allowed this client:
   *
   * - no grant yet, or a revoked one: this server only;
   * - a grant of servers: this server is added to them;
   * - a whole-workspace grant of the server's workspace: nothing to do;
   * - a whole-workspace grant of another workspace: replaced by this server
   *   (a grant cannot hold both).
   *
   * Nothing is added that the user did not allow this client before or does
   * not allow now, and every stored id is still re-validated on each use. The
   * server goes through the same checks as {@link grantServers}: an id the
   * user cannot reach or may not see is dropped and nothing is written.
   *
   * `onlyExisting` never creates a grant: for the SSO sign-in, which writes
   * none, so a client that has one can still be allowed a further server.
   *
   * Returns whether the grant now includes the server.
   */
  async grantRequestedServer(
    clientId: string,
    userId: string,
    serverId: string,
    opts: { onlyExisting?: boolean } = {},
  ): Promise<boolean> {
    const [server] = await this.keepVisible(userId, await this.validateServers(userId, [serverId]));
    if (!server) {
      this.logger.warn(`Dropped 1 unreachable server id(s) from a grant for user ${userId}`);
      return false;
    }

    const existing = await this.prisma.mcpConnectionGrant.findUnique({
      where: { clientId_userId: { clientId, userId } },
      select: { organizationId: true, serverIds: true, revokedAt: true },
    });
    if (!existing && opts.onlyExisting) return false;

    if (existing && !existing.revokedAt) {
      if (existing.organizationId === server.organizationId) return true;
      if (!existing.organizationId) {
        if (existing.serverIds.includes(server.id)) return true;
        // Appended in one statement, so two authorizations finishing together
        // cannot drop each other's server.
        await this.prisma.mcpConnectionGrant.updateMany({
          where: {
            clientId,
            userId,
            revokedAt: null,
            organizationId: null,
            NOT: { serverIds: { has: server.id } },
          },
          data: { serverIds: { push: server.id } },
        });
        this.grantRows.delete(this.grantRowKey(clientId, userId));
        return true;
      }
    }

    await this.upsert(
      clientId,
      userId,
      { organizationId: null, serverIds: [server.id] },
      server.organizationId,
    );
    return true;
  }

  /**
   * {@link grantRequestedServer} with `onlyExisting`, for a sign-in that knows
   * the pending authorization (`oauth_sessions.session_id`) instead of the
   * client.
   */
  async extendForAuthorization(
    oauthSessionId: string | undefined,
    userId: string,
    serverId: string,
  ): Promise<boolean> {
    if (!oauthSessionId || !userId || !serverId) return false;
    const session = await this.prisma.oAuthSession.findUnique({
      where: { sessionId: oauthSessionId },
      select: { clientId: true },
    });
    if (!session?.clientId) return false;
    return this.grantRequestedServer(session.clientId, userId, serverId, { onlyExisting: true });
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
    await this.upsert(clientId, userId, { organizationId, serverIds: [] }, organizationId);
    return true;
  }

  /**
   * Grant a specific set of MCP servers. Ids the user cannot reach are dropped;
   * if nothing is left the grant is not written at all, so a caller cannot turn
   * an entirely invalid selection into a stored empty grant.
   *
   * In a workspace with restricted member visibility, a server a member who is
   * not an admin there cannot see counts as unreachable too: it is dropped
   * exactly like an unknown id. Used by `PUT /api/mcp-connections/:clientId`
   * and by the OAuth consent page.
   *
   * Returns the ids actually granted.
   */
  async grantServers(
    clientId: string,
    userId: string,
    serverIds: string[],
  ): Promise<string[]> {
    const valid = await this.keepVisible(userId, await this.validateServers(userId, serverIds));
    const dropped = serverIds.length - valid.length;
    if (dropped > 0) {
      this.logger.warn(
        `Dropped ${dropped} unreachable server id(s) from a grant for user ${userId}`,
      );
    }
    if (valid.length === 0) return [];

    await this.upsert(
      clientId,
      userId,
      { organizationId: null, serverIds: valid.map((s) => s.id) },
      valid[0].organizationId,
    );
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
    this.grantRows.delete(this.grantRowKey(clientId, userId));
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
   *
   * Member visibility is decided per workspace, by that workspace's own mode
   * and the user's role there: in a restricted workspace where the user is not
   * an admin, only the servers they own are listed, each with the count of its
   * connectors they may see. Feeds both
   * `GET /api/mcp-connections/targets` and the OAuth consent page's picker.
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
        role: true,
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

    const targets = memberships.map((m) => ({
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      servers: m.organization.mcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        connectorCount: s._count.connectors,
      })),
    }));
    if (!this.visibility) return targets;

    // One workspace at a time: the mode and the role differ per workspace.
    for (let i = 0; i < memberships.length; i++) {
      const scope = await this.scopeIn(userId, memberships[i].role, targets[i].organizationId);
      if (!scope.restricted) continue;
      targets[i].servers = await this.visibleActiveServers(targets[i].organizationId, scope);
    }
    return targets;
  }

  /** The user's member visibility in one workspace, from their role there. */
  private scopeIn(userId: string, role: string, organizationId: string): Promise<VisibilityScope> {
    // Only called when the service is present (see the callers).
    return this.visibility!.scopeFor({ sub: userId, role, organizationId });
  }

  /**
   * The active servers of one workspace the scope may see, oldest first, each
   * with the count of its connectors the scope may see. Filtered in SQL.
   */
  private async visibleActiveServers(
    organizationId: string,
    scope: VisibilityScope,
  ): Promise<{ id: string; name: string; connectorCount: number }[]> {
    const rows = await this.prisma.mcpServerConfig.findMany({
      where: { AND: [{ organizationId, isActive: true }, serverWhere(scope)] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        _count: { select: { connectors: { where: { connector: connectorWhere(scope) } } } },
      },
    });
    return rows.map((s) => ({ id: s.id, name: s.name, connectorCount: s._count.connectors }));
  }

  /**
   * Of servers the user can already reach (see {@link validateServers}), the
   * ones member visibility lets them see, in the same order. A workspace in
   * open mode, or where the user is an admin, keeps all of its servers; in a
   * restricted one a member who is not an admin keeps only their own. The
   * role comes from the membership row; a server whose membership row is
   * gone is dropped (fail closed). Also used to name servers to the user
   * (connections list, consent page).
   */
  async keepVisible(
    userId: string,
    servers: { id: string; organizationId: string }[],
  ): Promise<{ id: string; organizationId: string }[]> {
    if (!this.visibility || servers.length === 0) return servers;

    const orgIds = [...new Set(servers.map((s) => s.organizationId))];
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId, organizationId: { in: orgIds }, deactivatedAt: null },
      select: { organizationId: true, role: true },
    });
    const roleIn = new Map(memberships.map((m) => [m.organizationId, m.role as string]));

    const keep = new Set<string>();
    for (const organizationId of orgIds) {
      const role = roleIn.get(organizationId);
      if (!role) continue;
      const ids = servers.filter((s) => s.organizationId === organizationId).map((s) => s.id);
      const scope = await this.scopeIn(userId, role, organizationId);
      if (!scope.restricted) {
        ids.forEach((id) => keep.add(id));
        continue;
      }
      const visible = await this.prisma.mcpServerConfig.findMany({
        where: { AND: [{ id: { in: ids }, organizationId }, serverWhere(scope)] },
        select: { id: true },
      });
      visible.forEach((s) => keep.add(s.id));
    }
    return servers.filter((s) => keep.has(s.id));
  }

  /**
   * The active servers of one workspace this user may be shown, oldest first:
   * all of them in open mode or for an admin there, only their own in a
   * restricted workspace. Empty when they are not an active member. For the
   * server links handed to the model on the shared endpoint.
   */
  async serverNamesFor(userId: string, organizationId: string): Promise<Array<{ id: string; name: string }>> {
    if (!userId || !organizationId) return [];
    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId, deactivatedAt: null },
      select: { role: true },
    });
    if (!membership) return [];
    const scope: VisibilityScope = this.visibility
      ? await this.scopeIn(userId, membership.role as string, organizationId)
      : { restricted: false };
    return this.prisma.mcpServerConfig.findMany({
      where: { AND: [{ organizationId, isActive: true }, serverWhere(scope)] },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Whether member visibility narrows this user's view of one workspace (a
   * member who is not an admin there, in a restricted workspace). False when
   * they are not an active member.
   */
  async restrictedIn(userId: string, organizationId: string): Promise<boolean> {
    if (!this.visibility || !userId || !organizationId) return false;
    const membership = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId, deactivatedAt: null },
      select: { role: true },
    });
    if (!membership) return false;
    return (await this.scopeIn(userId, membership.role as string, organizationId)).restricted;
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
    /** Workspace the grant points into, for the product event. */
    eventOrganizationId?: string,
  ): Promise<void> {
    const existing = await this.prisma.mcpConnectionGrant.findUnique({
      where: { clientId_userId: { clientId, userId } },
      select: { id: true },
    });
    await this.prisma.mcpConnectionGrant.upsert({
      where: { clientId_userId: { clientId, userId } },
      create: { clientId, userId, ...data },
      // Choosing again un-revokes: the user is explicitly saying what this
      // client may reach, which is the opposite of having revoked it.
      update: { ...data, revokedAt: null },
    });
    this.grantRows.delete(this.grantRowKey(clientId, userId));
    if (!existing) await this.reportConnected(clientId, userId, eventOrganizationId);
  }

  /** First connection of this client for this user: the funnel step between sign-up and first call. */
  /**
   * The redirect URIs an OAuth client registered, which tell which assistant
   * it is (see `profileForRedirectUris`). A registration never changes them,
   * so they are cached; a lookup failure answers `[]`, which means the default
   * tool set.
   */
  async clientRedirectUris(clientId: string | undefined): Promise<string[]> {
    if (!clientId) return [];
    const cached = this.redirectUrisByClient.get(clientId);
    if (cached) return cached;
    const row = await this.prisma.oAuthClient
      .findUnique({ where: { clientId }, select: { redirectUris: true } })
      .catch(() => null);
    if (!row) return [];
    if (this.redirectUrisByClient.size >= REDIRECT_URI_CACHE_MAX) this.redirectUrisByClient.clear();
    this.redirectUrisByClient.set(clientId, row.redirectUris);
    return row.redirectUris;
  }

  private async reportConnected(
    clientId: string,
    userId: string,
    organizationId?: string,
  ): Promise<void> {
    if (!this.events) return;
    const client = await this.prisma.oAuthClient
      .findUnique({ where: { clientId }, select: { clientName: true } })
      .catch(() => null);
    await this.events.log({
      event: ProductEvents.AI_CLIENT_CONNECTED,
      userId,
      organizationId: organizationId ?? null,
      metadata: { client: client?.clientName ?? 'unknown' },
    });
  }
}
