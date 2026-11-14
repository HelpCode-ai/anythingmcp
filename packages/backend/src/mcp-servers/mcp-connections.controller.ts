import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
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

  @Get()
  @ApiOperation({ summary: 'AI clients connected to the shared /mcp endpoint' })
  async list(@Req() req: any) {
    const userId = req.user.sub;
    const grants = await this.grants.listForUser(userId);
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

    const clientName = new Map(clients.map((c) => [c.clientId, c.clientName]));
    const serverById = new Map(servers.map((s) => [s.id, s]));
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
      'In a workspace with restricted member visibility where you are not an admin, only the servers you own or that ' +
      'hold a connector you can see are listed, each counting only those connectors; every workspace follows its own ' +
      'setting and your role there.',
  })
  async targets(@Req() req: any) {
    return this.grants.listSelectableTargets(req.user.sub);
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
      'In a workspace with restricted member visibility where you are not an admin, a server you cannot see is dropped like an unknown id.\n\n' +
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
    } else if (dto.serverIds?.length) {
      const granted = await this.grants.grantServers(
        clientId,
        userId,
        dto.serverIds,
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
        serverIds: dto.serverIds,
      },
    });

    return { ok: true };
  }

  @Delete(':clientId')
  @ApiOperation({ summary: 'Revoke a connection — it then reaches nothing' })
  async revoke(@Req() req: any, @Param('clientId') clientId: string) {
    const userId = req.user.sub;
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
