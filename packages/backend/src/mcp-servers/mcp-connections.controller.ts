import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { isApiKeyRequest } from '../auth/api-key-request.util';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags, ApiSecurity } from '@nestjs/swagger';
import { McpConnectionGrantService } from './mcp-connection-grant.service';
import { PrismaService } from '../common/prisma.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../audit/security-event.service';

interface UpdateConnectionDto {
  /** Grant a whole workspace. Mutually exclusive with `serverIds`. */
  organizationId?: string;
  /** Grant specific MCP servers. */
  serverIds?: string[];
}

/**
 * What each connected AI client may reach, and the ability to change it.
 *
 * This exists because a user cannot rely on their client to ask again. Claude
 * holds an access token for a day and a refresh token for thirty, and reuses
 * cached credentials aggressively — this deployment's own OAuth data shows a
 * connector added months after the first authorization reusing the stored token
 * without prompting. So "disconnect and reconnect" is not a dependable way to
 * change what a connection sees. This is.
 *
 * Changes take effect on the connection's very next request: the grant is
 * re-read, and re-validated, per request.
 */
@ApiTags('MCP Connections')
@Controller('api/mcp-connections')
@UseGuards(JwtOrManagementKeyGuard)
@ApiBearerAuth()
@ApiSecurity('api-key')
export class McpConnectionsController {
  constructor(
    private readonly grants: McpConnectionGrantService,
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  /**
   * The workspace a management API key acts in, or null for a dashboard
   * session. Grants belong to the user across all their workspaces; a key
   * only sees and changes the ones of its own workspace.
   */
  private keyWorkspace(req: any): string | null {
    return isApiKeyRequest(req) ? (req.user?.organizationId ?? null) : null;
  }

  /**
   * Whether a grant lies entirely in one workspace: the whole of it, or only
   * servers of it (servers deleted since are ignored, as in the list).
   */
  private static grantWithin(
    grant: { organizationId: string | null; serverIds: string[] },
    organizationId: string,
    serverOrg: Map<string, string>,
  ): boolean {
    if (grant.organizationId) return grant.organizationId === organizationId;
    const known = grant.serverIds.filter((id) => serverOrg.has(id));
    return known.length > 0 && known.every((id) => serverOrg.get(id) === organizationId);
  }

  /**
   * For a request made with an API key: refuse to change a grant that does
   * not exist or lies (partly) outside the key's workspace.
   */
  private async assertGrantInKeyWorkspace(
    clientId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const grant = await this.prisma.mcpConnectionGrant.findUnique({
      where: { clientId_userId: { clientId, userId } },
      select: { organizationId: true, serverIds: true },
    });
    const servers = grant?.serverIds.length
      ? await this.prisma.mcpServerConfig.findMany({
          where: { id: { in: grant.serverIds } },
          select: { id: true, organizationId: true },
        })
      : [];
    const serverOrg = new Map(servers.map((s) => [s.id, s.organizationId]));
    if (!grant || !McpConnectionsController.grantWithin(grant, organizationId, serverOrg)) {
      throw new ForbiddenException(
        "This API key can only change connections of its own workspace",
      );
    }
  }

  @Get()
  @ApiOperation({
    summary: 'AI clients connected to the shared /mcp endpoint',
    description:
      'Your own connections only. In a workspace with restricted member visibility where you are not an admin, a ' +
      'granted server you do not own is left out of `servers`.',
  })
  async list(@Req() req: any) {
    const userId = req.user.sub;
    const keyOrg = this.keyWorkspace(req);
    let grants = await this.grants.listForUser(userId);
    if (grants.length === 0) return [];

    // Names for the ids, resolved in two queries rather than per row.
    const [clients, servers, organizations] = await Promise.all([
      this.prisma.oAuthClient.findMany({
        where: { clientId: { in: grants.map((g) => g.clientId) } },
        select: { clientId: true, clientName: true },
      }),
      this.prisma.mcpServerConfig.findMany({
        where: { id: { in: grants.flatMap((g) => g.serverIds) } },
        select: { id: true, name: true, organizationId: true },
      }),
      this.prisma.organization.findMany({
        where: {
          id: {
            in: grants
              .map((g) => g.organizationId)
              .filter((id): id is string => !!id),
          },
        },
        select: { id: true, name: true },
      }),
    ]);

    // With an API key, only the connections of the key's workspace.
    if (keyOrg) {
      const serverOrg = new Map(servers.map((s) => [s.id, s.organizationId]));
      grants = grants.filter((g) => McpConnectionsController.grantWithin(g, keyOrg, serverOrg));
    }

    const clientName = new Map(clients.map((c) => [c.clientId, c.clientName]));
    // Named only when member visibility lets this user see the server.
    const shown = new Set((await this.grants.keepVisible(userId, servers)).map((s) => s.id));
    const serverById = new Map(servers.filter((s) => shown.has(s.id)).map((s) => [s.id, s]));
    const orgName = new Map(organizations.map((o) => [o.id, o.name]));

    return grants.map((g) => ({
      clientId: g.clientId,
      clientName: clientName.get(g.clientId) ?? g.clientId,
      revoked: !!g.revokedAt,
      // A server that has since been deleted simply drops out, rather than
      // showing a dangling id.
      servers: g.serverIds
        .map((id) => serverById.get(id))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => ({ id: s.id, name: s.name })),
      wholeWorkspace: g.organizationId
        ? { id: g.organizationId, name: orgName.get(g.organizationId) ?? '' }
        : null,
      connectedAt: g.createdAt,
      updatedAt: g.updatedAt,
    }));
  }

  @Get('targets')
  @ApiOperation({
    summary: 'Workspaces and MCP servers this user can grant access to',
    description:
      'In a workspace with restricted member visibility where you are not an admin, only the servers you own are ' +
      'listed, each counting only the connectors you can see; every workspace follows its own setting and your role ' +
      'there. The whole-workspace choice stays available. Called with a management API key, only the key\'s own ' +
      'workspace is listed.',
  })
  async targets(@Req() req: any) {
    const targets = await this.grants.listSelectableTargets(req.user.sub);
    const keyOrg = this.keyWorkspace(req);
    return keyOrg ? targets.filter((t) => t.organizationId === keyOrg) : targets;
  }

  @Put(':clientId')
  @ApiOperation({
    summary: 'Change what a connected client may reach',
    description:
      'Replaces the grant of one connected AI client (`clientId` from GET /api/mcp-connections): either a whole ' +
      'workspace (`organizationId`) or a list of MCP servers (`serverIds`), as listed by GET /api/mcp-connections/targets. ' +
      'When both are given, `organizationId` wins. The change applies from the client\'s next request.\n\n' +
      'Answers `{ "ok": true }`, or `{ "ok": false, "reason": … }`: `not-a-member` (you are not in that workspace), ' +
      '`nothing-granted` (you can reach none of the servers; unreachable ids are dropped) or `empty-selection` (neither field given). ' +
      'In a workspace with restricted member visibility where you are not an admin, a server you do not own is dropped like an unknown id.\n\n' +
      'Called with a management API key: only an existing connection of the key\'s own workspace can be changed (403 otherwise), ' +
      '`organizationId` must be that workspace (403 otherwise) and servers of other workspaces are dropped like unknown ids.\n\n' +
      '```bash\namcp api PUT /api/mcp-connections/$CLIENT_ID --data \'{"serverIds":["cmo9x1k2a0001abcdpq7rs8tu"]}\' --yes\n```',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        organizationId: { type: 'string', description: 'Grant every MCP server of this workspace.' },
        serverIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Grant only these MCP servers; ignored when `organizationId` is given.',
        },
      },
    },
    examples: {
      servers: { summary: 'Only one MCP server', value: { serverIds: ['cmo9x1k2a0001abcdpq7rs8tu'] } },
      workspace: { summary: 'A whole workspace', value: { organizationId: 'cmo9w7y3b0000abcdk1lm2nop' } },
    },
  })
  async update(
    @Req() req: any,
    @Param('clientId') clientId: string,
    @Body() dto: UpdateConnectionDto,
  ) {
    const userId = req.user.sub;
    const keyOrg = this.keyWorkspace(req);
    let serverIds = dto.serverIds;
    if (keyOrg) {
      await this.assertGrantInKeyWorkspace(clientId, userId, keyOrg);
      if (dto.organizationId && dto.organizationId !== keyOrg) {
        throw new ForbiddenException(
          "This API key can only grant its own workspace",
        );
      }
      if (!dto.organizationId && serverIds?.length) {
        const inWorkspace = await this.prisma.mcpServerConfig.findMany({
          where: { id: { in: serverIds }, organizationId: keyOrg },
          select: { id: true },
        });
        const keep = new Set(inWorkspace.map((s) => s.id));
        serverIds = serverIds.filter((id) => keep.has(id));
        if (serverIds.length === 0) return { ok: false, reason: 'nothing-granted' };
      }
    }

    // Both writes validate membership themselves and drop what this user
    // cannot reach, so a request naming another tenant's workspace or server
    // concedes nothing — it simply grants less than it asked for, or fails.
    if (dto.organizationId) {
      const ok = await this.grants.grantWholeOrganization(
        clientId,
        userId,
        dto.organizationId,
      );
      if (!ok) return { ok: false, reason: 'not-a-member' };
    } else if (serverIds?.length) {
      const granted = await this.grants.grantServers(
        clientId,
        userId,
        serverIds,
      );
      if (granted.length === 0) return { ok: false, reason: 'nothing-granted' };
    } else {
      return { ok: false, reason: 'empty-selection' };
    }

    await this.securityEvents.log({
      event: SecurityEvents.MCP_GRANT_CHANGED,
      actorType: 'USER',
      actorUserId: userId,
      organizationId: req.user.organizationId ?? null,
      metadata: {
        clientId,
        organizationId: dto.organizationId,
        serverIds,
      },
    });

    return { ok: true };
  }

  @Delete(':clientId')
  @ApiOperation({
    summary: 'Revoke a connection — it then reaches nothing',
    description:
      'Called with a management API key, only a connection of the key\'s own workspace can be revoked (403 otherwise).',
  })
  async revoke(@Req() req: any, @Param('clientId') clientId: string) {
    const userId = req.user.sub;
    const keyOrg = this.keyWorkspace(req);
    if (keyOrg) await this.assertGrantInKeyWorkspace(clientId, userId, keyOrg);
    const revoked = await this.grants.revoke(clientId, userId);

    if (revoked) {
      await this.securityEvents.log({
        event: SecurityEvents.MCP_GRANT_REVOKED,
        actorType: 'USER',
        actorUserId: userId,
        organizationId: req.user.organizationId ?? null,
        metadata: { clientId },
      });
    }

    return { ok: revoked };
  }
}
