import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiSecurity, ApiBody, ApiResponse } from '@nestjs/swagger';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { IsString, IsOptional, IsIn } from 'class-validator';
import { McpApiKeysService } from './mcp-api-keys.service';
import {
  MemberVisibilityService,
  canSeeServer,
  type VisibilityScope,
} from '../settings/member-visibility.service';
import type { McpApiKeyScope } from '../generated/prisma/client';

class CreateKeyDto {
  @ApiProperty({
    description: 'Label for the key (visible only to its owner).',
    example: 'claude-desktop',
  })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description:
      'Scope the key to a specific MCP server. Omit for an account-wide key (access to all assigned servers).',
  })
  @IsOptional()
  @IsString()
  mcpServerId?: string;

  @ApiPropertyOptional({
    description:
      'What the key may reach. MCP (default): tool calls on /mcp only. ' +
      'MANAGEMENT_READ / MANAGEMENT_ADMIN: the management API (CLI), read-only ' +
      'or full. The key is always still capped by the owner\'s role.',
    enum: ['MCP', 'MANAGEMENT_READ', 'MANAGEMENT_ADMIN'],
  })
  @IsOptional()
  @IsIn(['MCP', 'MANAGEMENT_READ', 'MANAGEMENT_ADMIN'])
  scope?: McpApiKeyScope;
}

@ApiTags('MCP API Keys')
@ApiBearerAuth()
@ApiSecurity('api-key')
@UseGuards(JwtOrManagementKeyGuard)
@Controller('api/mcp-keys')
export class McpApiKeysController {
  constructor(
    private readonly keysService: McpApiKeysService,
    // Not @Optional: Nest refuses to boot without it. It is missing only in
    // unit specs that build the controller by hand and predate the setting.
    private readonly visibility?: MemberVisibilityService,
  ) {}

  /**
   * Member visibility: of `serverIds`, the servers the caller may not see. In
   * a restricted workspace where the caller is not an admin, that is every
   * server they do not own; each workspace follows its own mode and the
   * caller's role there. A server in a workspace the caller is not an active
   * member of counts as hidden. Empty for admins and open workspaces.
   */
  private async hiddenServers(req: any, serverIds: string[]): Promise<Set<string>> {
    const hidden = new Set<string>();
    if (!this.visibility || serverIds.length === 0) return hidden;
    const scopes = new Map<string, VisibilityScope>();
    for (const server of await this.keysService.serverFacts(req.user.sub, serverIds)) {
      if (server.ownerId === req.user.sub) continue;
      if (!server.role) {
        hidden.add(server.id);
        continue;
      }
      let scope = scopes.get(server.organizationId);
      if (!scope) {
        scope = await this.visibility.scopeFor({
          sub: req.user.sub,
          role: server.role,
          organizationId: server.organizationId,
        });
        scopes.set(server.organizationId, scope);
      }
      if (!canSeeServer(scope, { userId: server.ownerId })) hidden.add(server.id);
    }
    return hidden;
  }

  @Get()
  @ApiOperation({
    summary: 'List my MCP API keys',
    description:
      'Your own keys in every scope, with name, scope, server, active flag and last use. The key value is masked ' +
      '(only its last 8 characters are shown); the full value is returned once, at creation. In a workspace with ' +
      'restricted member visibility where you are not an admin, `mcpServer` is null on a key for a server you do not own.',
  })
  async listKeys(@Req() req: any) {
    const keys = await this.keysService.listByUser(req.user.sub);
    const hidden = await this.hiddenServers(
      req,
      keys.map((k) => k.mcpServerId).filter((id): id is string => !!id),
    );
    // Mask keys for display: show only last 8 chars
    return keys.map((k) => ({
      ...k,
      ...(k.mcpServerId && hidden.has(k.mcpServerId) ? { mcpServer: null } : {}),
      key: `mcp_${'•'.repeat(24)}${k.key.slice(-8)}`,
    }));
  }

  @Post()
  @ApiOperation({
    summary: 'Generate a new MCP API key',
    description:
      'Creates a key `mcp_…` owned by you and returns it in full, **once**: store it now.\n\n' +
      '- `scope: "MCP"` (default): for AI clients calling tools on `/mcp` (`X-API-Key` or `Authorization: Bearer`). ' +
      'With `mcpServerId` the key works on that server only.\n' +
      '- `scope: "MANAGEMENT_READ"`: this API, `GET`/`HEAD` only, e.g. for dashboards and audits.\n' +
      '- `scope: "MANAGEMENT_ADMIN"`: this API, any method. Only admins can create one (403 otherwise).\n\n' +
      'A key always acts with its owner\'s role and never grants more. `amcp login --browser` creates a management key ' +
      'for the CLI the same way. Revoke with `POST /api/mcp-keys/{id}/revoke`.\n\n' +
      '404 when `mcpServerId` is not a server of a workspace you belong to; in a workspace with restricted member ' +
      'visibility where you are not an admin, also for a server you do not own.',
  })
  @ApiBody({
    type: CreateKeyDto,
    examples: {
      client: {
        summary: 'Key for an AI client on one server',
        value: { name: 'claude-desktop', mcpServerId: 'cmo9x1k2a0001abcdpq7rs8tu', scope: 'MCP' },
      },
      ciRead: { summary: 'Read-only key for CI', value: { name: 'ci-audit', scope: 'MANAGEMENT_READ' } },
      admin: { summary: 'Full management key (admins only)', value: { name: 'terraform', scope: 'MANAGEMENT_ADMIN' } },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'The new key. `key` is shown only in this response.',
    schema: {
      type: 'object',
      example: {
        id: 'cmoa2b3c40002efghuv9wx0yz',
        key: 'mcp_3f9a…c41d',
        name: 'ci-audit',
        isActive: true,
        mcpServerId: null,
        scope: 'MANAGEMENT_READ',
        createdAt: '2026-11-05T10:00:00.000Z',
      },
    },
  })
  async generateKey(@Req() req: any, @Body() dto: CreateKeyDto) {
    const scope: McpApiKeyScope = dto.scope ?? 'MCP';
    // A full-access management key is only meaningful for an admin; cap the
    // scope to the owner's role so a non-admin cannot mint one that implies
    // more than they have (the runtime RolesGuard would deny it anyway).
    if (scope === 'MANAGEMENT_ADMIN' && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('MANAGEMENT_ADMIN scope requires an admin role');
    }
    // Restricted member visibility: another member's server answers like an
    // unknown one (the service's 404).
    if (dto.mcpServerId && (await this.hiddenServers(req, [dto.mcpServerId])).has(dto.mcpServerId)) {
      throw new NotFoundException('MCP server not found');
    }
    // Returns the full key — user must save it, it won't be shown again
    return this.keysService.generate(
      req.user.sub,
      req.user.organizationId,
      dto.name,
      dto.mcpServerId,
      scope,
    );
  }

  @Post(':id/revoke')
  @ApiOperation({
    summary: 'Revoke (deactivate) an MCP API key',
    description:
      'Deactivates one of your own keys: from the next request on it is refused (401), on `/mcp` and on this API. ' +
      'The key stays in your list as inactive; `DELETE /api/mcp-keys/{id}` removes it. Only your own keys are affected.',
  })
  async revokeKey(@Req() req: any, @Param('id') id: string) {
    await this.keysService.revoke(id, req.user.sub);
    return { message: 'Key revoked' };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an MCP API key' })
  async deleteKey(@Req() req: any, @Param('id') id: string) {
    await this.keysService.deleteKey(id, req.user.sub);
    return { message: 'Key deleted' };
  }
}
