import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiProperty, ApiPropertyOptional, ApiSecurity, ApiBody, ApiResponse } from '@nestjs/swagger';
import { PaginationQueryDto } from '../common/pagination.dto';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { IsString, IsOptional, IsBoolean, IsArray, IsIn } from 'class-validator';
import { SKILLS_DELIVERY_MODES, type SkillsDelivery } from '../knowledge-graph/kg-skill.service';
import { CODE_MODE_MODES, type CodeMode } from '../mcp-server/code-tool.util';
import { McpServersService } from './mcp-servers.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { PrismaService } from '../common/prisma.service';

class CreateMcpServerDto {
  @ApiProperty({ description: 'Human-readable name.', example: 'Sales Workspace' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description:
      'URL-safe slug for the per-server MCP endpoint (e.g. /mcp/<slug>). Auto-generated if omitted.',
    example: 'sales-workspace',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ description: 'Free-text description (UI only).' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      'Markdown instructions surfaced to MCP clients on initialize(). Concatenated with each assigned connector\'s instructions.',
  })
  @IsOptional()
  @IsString()
  instructions?: string;
}

class UpdateMcpServerDto {
  @ApiPropertyOptional({ description: 'Human-readable name.' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'URL-safe slug.' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ description: 'Free-text description.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Markdown instructions for MCP clients.' })
  @IsOptional()
  @IsString()
  instructions?: string;

  @ApiPropertyOptional({ description: 'Set to false to disable the endpoint without deleting it.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    enum: SKILLS_DELIVERY_MODES,
    description:
      'How applied skills reach AI clients on connect: auto (full text while small, else an index for skill_get), inline (always the full text), index (always the index).',
  })
  @IsOptional()
  @IsIn(SKILLS_DELIVERY_MODES as unknown as string[])
  skillsDelivery?: SkillsDelivery;

  @ApiPropertyOptional({
    enum: CODE_MODE_MODES,
    description:
      'Code mode for this server: off (default, no code execution), tools (saved code tools only), inline (also the generic code_execute / code_propose_tool). Needs a configured code-runner to actually run.',
    example: 'inline',
  })
  @IsOptional()
  @IsIn(CODE_MODE_MODES as unknown as string[])
  codeMode?: CodeMode;
}

class AssignConnectorsDto {
  @ApiProperty({
    description:
      'Connector IDs to expose under this MCP server. Replaces the existing assignment.',
    type: [String],
    example: ['cmob60dvv00c01zrpeujwmnep'],
  })
  @IsArray()
  @IsString({ each: true })
  connectorIds: string[];
}

@ApiTags('MCP Servers')
@ApiBearerAuth()
@ApiSecurity('api-key')
@UseGuards(JwtOrManagementKeyGuard)
@Controller('api/mcp-servers')
export class McpServersController {
  constructor(
    private readonly mcpServersService: McpServersService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly prisma: PrismaService,
  ) {}

  private assertOrgMatch(server: any, req: any) {
    if (server.organizationId !== req.user.organizationId) {
      throw new NotFoundException('MCP server not found');
    }
  }

  private assertCanWrite(server: any, req: any) {
    this.assertOrgMatch(server, req);
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot modify MCP servers');
    }
    if (server.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException();
    }
  }

  @Get()
  @ApiOperation({
    summary: 'List MCP servers for current organization',
    description:
      'Every MCP server of your workspace, oldest first. Each one is an MCP endpoint at `/mcp/{id}` that exposes the ' +
      'tools of its connectors. Includes the names of its connectors, `_count` (connectors, API keys) and `usage` ' +
      '(`calls30d`, `lastCallAt`). Without `limit` all servers are returned.\n\n' +
      '```bash\namcp api GET /api/mcp-servers\n```',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size, 1..200. Omit for all.', example: 50 })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Rows to skip.', example: 0 })
  async list(@Req() req: any, @Query() pagination: PaginationQueryDto) {
    const servers = await this.mcpServersService.findAllByOrg(req.user.organizationId, {
      limit: pagination.limit,
      offset: pagination.offset,
    });
    // A stats query failing must not take the server list down with it.
    const usage = await this.mcpServersService
      .usageByServer(servers.map((s) => s.id))
      .catch(() => new Map<string, { calls30d: number; lastCallAt: Date | null }>());
    return servers.map((s) => ({
      ...s,
      usage: usage.get(s.id) ?? { calls30d: 0, lastCallAt: null },
    }));
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new MCP server',
    description:
      'Creates an empty MCP server; its endpoint is `/mcp/{id}` (the `id` in the response). Then put connectors on it ' +
      'with `PUT /api/mcp-servers/{id}/connectors`, set code mode or skills delivery with `PUT /api/mcp-servers/{id}`, ' +
      'and give AI clients a key with `POST /api/mcp-keys` (`mcpServerId`) or let them sign in with OAuth. ' +
      'A slug is derived from the name when omitted; a slug already used in the workspace answers 409. ' +
      '403 when the plan allows no more MCP servers.',
  })
  @ApiBody({
    type: CreateMcpServerDto,
    examples: {
      sales: {
        summary: 'A server for the sales team',
        value: {
          name: 'Sales',
          description: 'CRM and e-mail tools for the sales team',
          instructions: 'Use HubSpot for customer data. Never delete records.',
        },
      },
    },
  })
  async create(@Req() req: any, @Body() dto: CreateMcpServerDto) {
    await this.licenseGuard.checkCanCreateMcpServer(req.user.sub, req.user.organizationId);
    return this.mcpServersService.create(req.user.sub, req.user.organizationId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get MCP server detail' })
  async get(@Req() req: any, @Param('id') id: string) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    this.assertOrgMatch(server, req);
    const apiKeys = await this.mcpServersService.listOwnKeysForServer(
      id,
      req.user.sub,
      req.user.organizationId,
    );
    return { ...server, apiKeys };
  }

  @Get(':id/activity')
  @ApiOperation({
    summary: 'Calls in the last 30 days and the time of the last one',
    description:
      'Tool calls made through this server in the last 30 days and when the last one happened. Polled by the connect ' +
      'page to show when the first request from an AI client arrives; also a cheap way to check a server is in use.',
  })
  @ApiResponse({
    status: 200,
    schema: { type: 'object', example: { calls30d: 1284, lastCallAt: '2026-11-05T09:41:12.000Z' } },
  })
  async activity(@Req() req: any, @Param('id') id: string) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    this.assertOrgMatch(server, req);
    const usage = await this.mcpServersService.usageByServer([id]);
    return usage.get(id) ?? { calls30d: 0, lastCallAt: null };
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update MCP server',
    description:
      'Changes only the fields sent. `codeMode` controls code execution on this server:\n\n' +
      '- `off` (default): no code execution.\n' +
      '- `tools`: saved code tools (approved programs stored as tools) can run.\n' +
      '- `inline`: also the generic `code_execute` (run a short program that calls several tools in one step) and ' +
      '`code_propose_tool` (propose a program as a saved code tool for an admin to approve).\n\n' +
      'Code runs in an isolated sandbox and needs a configured code-runner. `skillsDelivery` sets how applied skills ' +
      'reach clients (`auto`, `inline`, `index`); `isActive: false` switches the endpoint off. Only the server owner or ' +
      'an admin may change it; a slug already used in the workspace answers 409.\n\n' +
      '```bash\namcp api PUT /api/mcp-servers/<id> --data \'{"codeMode":"inline"}\' --yes\n```',
  })
  @ApiBody({
    type: UpdateMcpServerDto,
    examples: {
      codeMode: { summary: 'Turn on code mode', value: { codeMode: 'inline' } },
      disable: { summary: 'Switch the endpoint off', value: { isActive: false } },
      instructions: {
        summary: 'Change the instructions sent to AI clients',
        value: { instructions: 'Answer in English. Use the ERP for prices, never the web.' },
      },
    },
  })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateMcpServerDto) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    this.assertCanWrite(server, req);
    return this.mcpServersService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete MCP server' })
  async delete(@Req() req: any, @Param('id') id: string) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    this.assertCanWrite(server, req);
    await this.mcpServersService.delete(id);
    return { message: 'MCP server deleted' };
  }

  @Put(':id/connectors')
  @ApiOperation({
    summary: 'Assign connectors to MCP server',
    description:
      'Sets the connectors whose tools this server exposes. The list **replaces** the current assignment: send every ' +
      'connector that should stay, or `[]` to remove them all. Connected AI clients are told the tool list changed. ' +
      '404 when an id is not a connector of your workspace. Which tools each user may call is then decided by roles ' +
      '(`/api/roles`).\n\n' +
      '```bash\namcp api PUT /api/mcp-servers/<id>/connectors --data \'{"connectorIds":["<connectorId>"]}\' --yes\n```',
  })
  @ApiResponse({ status: 200, schema: { type: 'object', example: { message: 'Connectors assigned' } } })
  async assignConnectors(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: AssignConnectorsDto,
  ) {
    const server = await this.mcpServersService.findById(id);
    if (!server) throw new NotFoundException('MCP server not found');
    this.assertCanWrite(server, req);

    // Validate that all connectors belong to the same organization
    if (dto.connectorIds.length > 0) {
      const orgCount = await this.prisma.connector.count({
        where: { id: { in: dto.connectorIds }, organizationId: req.user.organizationId },
      });
      if (orgCount !== dto.connectorIds.length) {
        throw new NotFoundException('One or more connectors not found');
      }
    }

    await this.mcpServersService.assignConnectors(id, dto.connectorIds);
    return { message: 'Connectors assigned' };
  }
}
