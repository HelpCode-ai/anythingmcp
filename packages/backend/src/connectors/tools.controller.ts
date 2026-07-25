import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import {
  IsString,
  IsOptional,
  IsObject,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { ConnectorsService } from './connectors.service';
import { inferJsonSchema } from './output-schema.util';
import { classifyToolExecutionError } from './connector-error.util';
import {
  ToolAnnotations,
  deriveToolAnnotations,
  parseAnnotationsOverride,
} from '../mcp-server/tool-annotations';
import {
  CALLER_CONTEXT_VARIABLES,
  findUnknownCallerContextVars,
} from '../common/caller-context.util';

class CreateToolDto {
  @ApiProperty({
    description: 'Tool name exposed via MCP (unique per connector).',
    example: 'list_invoices',
  })
  @IsString()
  name: string;

  @ApiProperty({
    description: 'One-line description shown in MCP tools/list.',
    example: 'List all invoices for the given customer.',
  })
  @IsString()
  description: string;

  @ApiProperty({
    description: 'JSON Schema describing the tool input parameters.',
    type: 'object',
    additionalProperties: true,
    example: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
  })
  @IsObject()
  parameters: Record<string, unknown>;

  @ApiProperty({
    description:
      'Engine-specific routing. For REST: { method, path, queryParams?, bodyMapping?, headers? }.',
    type: 'object',
    additionalProperties: true,
    example: { method: 'GET', path: '/customers/{customerId}/invoices' },
  })
  @IsObject()
  endpointMapping: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Optional response shaping (field selection, rename).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  responseMapping?: Record<string, unknown>;
}

class UpdateToolDto {
  @ApiPropertyOptional({ description: 'Tool name.' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'One-line description.' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'JSON Schema for input parameters.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Engine-specific routing.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  endpointMapping?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Response shaping.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  responseMapping?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Set to false to hide the tool from MCP without deleting it.',
  })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

class BulkCreateToolsDto {
  @ApiProperty({
    description: 'Tools to create in a single call. Duplicates (same name) on the connector are skipped.',
    type: [CreateToolDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateToolDto)
  tools: CreateToolDto[];
}

class SetToolAnnotationsDto {
  @ApiPropertyOptional({
    description:
      'MCP tool annotations to advertise for this tool, overriding the values ' +
      'derived from the connector. Allowed keys: title, readOnlyHint, ' +
      'destructiveHint, idempotentHint, openWorldHint. Send null to drop the ' +
      'override and go back to the derived values. Typical use: marking a ' +
      'search endpoint that is exposed over POST as readOnlyHint=true.',
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { readOnlyHint: true },
  })
  @IsOptional()
  @IsObject()
  annotations?: Record<string, unknown> | null;
}

class SetToolProxyDto {
  @ApiProperty({
    description:
      'Whether this tool should route its request through the configured proxy / web-unblocker.',
  })
  @IsBoolean()
  useProxy: boolean;
}

class TestToolDto {
  @ApiPropertyOptional({
    description:
      'MCP-standard input map for the tool. Equivalent to the `arguments` field MCP clients send.',
    type: 'object',
    additionalProperties: true,
    example: { customerId: 'cus_123' },
  })
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Legacy alias for `arguments`. Accepted for backward compatibility; new clients should use `arguments`.',
    deprecated: true,
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

@ApiTags('Tools')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/connectors/:connectorId/tools')
export class ToolsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
    private readonly connectorsService: ConnectorsService,
  ) {}

  private async assertConnectorOrgMatch(connectorId: string, req: any) {
    const connector = await this.connectorsService.findById(connectorId);
    if (connector.organizationId !== req.user.organizationId) {
      throw new ForbiddenException('Resource not found');
    }
    return connector;
  }

  private async assertCanWriteConnector(connectorId: string, req: any) {
    const connector = await this.assertConnectorOrgMatch(connectorId, req);
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot modify tools');
    }
    if (connector.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the connector owner or an admin can modify this resource');
    }
    return connector;
  }

  /**
   * Reject a typo'd reserved variable (e.g. `{{amcp.user_mail}}`) at save time.
   * At runtime these resolve to an empty string on purpose — so without this
   * check a misspelling would silently forward nothing.
   */
  private assertKnownCallerContextVars(endpointMapping: unknown) {
    const unknown = findUnknownCallerContextVars(endpointMapping);
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown caller-context variable(s): ${unknown.join(', ')}. ` +
          `Available: ${Object.keys(CALLER_CONTEXT_VARIABLES).join(', ')}.`,
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'List tools for a connector' })
  async list(@Req() req: any, @Param('connectorId') connectorId: string) {
    await this.assertConnectorOrgMatch(connectorId, req);
    return this.prisma.mcpTool.findMany({
      where: { connectorId },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a new MCP tool for a connector' })
  async create(
    @Req() req: any,
    @Param('connectorId') connectorId: string,
    @Body() dto: CreateToolDto,
  ) {
    await this.assertCanWriteConnector(connectorId, req);
    this.assertKnownCallerContextVars(dto.endpointMapping);
    const tool = await this.prisma.mcpTool.create({
      data: {
        connectorId,
        name: dto.name,
        description: dto.description,
        parameters: dto.parameters as any,
        endpointMapping: dto.endpointMapping as any,
        responseMapping: dto.responseMapping as any,
      },
    });

    // Reload MCP tools for this connector
    await this.mcpServer.reloadConnectorTools(connectorId);
    return tool;
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Bulk create MCP tools for a connector',
    description:
      'Create multiple tools at once. Accepts an array of tool definitions. ' +
      'Skips duplicates (by name) and returns created + skipped counts.',
  })
  async bulkCreate(
    @Req() req: any,
    @Param('connectorId') connectorId: string,
    @Body() body: BulkCreateToolsDto,
  ) {
    await this.assertCanWriteConnector(connectorId, req);
    const toolDefs = body.tools;
    if (!Array.isArray(toolDefs) || toolDefs.length === 0) {
      return { error: 'Provide a "tools" array with at least one tool definition' };
    }

    const created = [];
    const skipped: string[] = [];

    for (const dto of toolDefs) {
      try {
        const tool = await this.prisma.mcpTool.create({
          data: {
            connectorId,
            name: dto.name,
            description: dto.description,
            parameters: dto.parameters as any,
            endpointMapping: dto.endpointMapping as any,
            responseMapping: dto.responseMapping as any,
          },
        });
        created.push(tool);
      } catch (err: any) {
        if (err.code === 'P2002') {
          skipped.push(dto.name);
        } else {
          throw err;
        }
      }
    }

    await this.mcpServer.reloadConnectorTools(connectorId);

    return {
      message: `Created ${created.length} tools${skipped.length > 0 ? `, skipped ${skipped.length} duplicates` : ''}`,
      tools: created,
      skipped,
    };
  }

  @Put(':toolId')
  @ApiOperation({ summary: 'Update an MCP tool' })
  async update(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
    @Body() dto: UpdateToolDto,
  ) {
    await this.assertCanWriteConnector(connectorId, req);
    if (dto.endpointMapping !== undefined) {
      this.assertKnownCallerContextVars(dto.endpointMapping);
    }
    // Bind the toolId to the connectorId in the WHERE clause so that
    // a request like /connectors/<my>/tools/<other-org's-tool> cannot
    // update a tool that doesn't belong to the requested connector.
    const result = await this.prisma.mcpTool.updateMany({
      where: { id: toolId, connectorId },
      data: dto as any,
    });
    if (result.count === 0) {
      throw new ForbiddenException('Tool not found');
    }

    await this.mcpServer.reloadConnectorTools(connectorId);
    return this.prisma.mcpTool.findUnique({ where: { id: toolId } });
  }

  @Get(':toolId/annotations')
  @ApiOperation({
    summary: 'Get the MCP annotations advertised for a tool',
    description:
      'Returns `derived` (inferred from the connector: HTTP verb, ' +
      'query/mutation, readOnly flag, SQL text), `override` (the stored ' +
      'explicit value, if any) and `effective` (what MCP clients actually ' +
      'see). Also lists the supported keys.',
  })
  async getAnnotations(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
  ) {
    const connector = await this.assertCanWriteConnector(connectorId, req);
    const tool = await this.prisma.mcpTool.findFirst({
      where: { id: toolId, connectorId },
    });
    if (!tool) throw new ForbiddenException('Tool not found');

    const source = {
      name: tool.name,
      connectorType: (connector as { type: string }).type,
      endpointMapping: tool.endpointMapping as { method?: string; path?: string },
      connectorConfig: {
        config: (connector as { config?: Record<string, unknown> | null }).config,
      },
    };
    return {
      derived: deriveToolAnnotations(source),
      override: (tool.annotations as Record<string, unknown> | null) ?? null,
      effective: deriveToolAnnotations({ ...source, annotations: tool.annotations }),
      supportedKeys: [
        'title',
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ],
    };
  }

  @Patch(':toolId/annotations')
  @ApiOperation({
    summary: 'Override the MCP annotations advertised for a tool',
    description:
      'Annotations are advisory hints (per the MCP spec, clients must not base ' +
      'trust decisions on them) that let an agent tell a read-only tool from a ' +
      'mutating one. They are normally derived from the connector; use this to ' +
      'correct a case the derivation cannot know — most commonly a read-only ' +
      'search exposed over POST. Send `annotations: null` to reset to derived.',
  })
  async setAnnotations(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
    @Body() dto: SetToolAnnotationsDto,
  ) {
    const connector = await this.assertCanWriteConnector(connectorId, req);

    let override: ToolAnnotations | null;
    try {
      override = parseAnnotationsOverride(dto.annotations ?? null);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }

    const result = await this.prisma.mcpTool.updateMany({
      where: { id: toolId, connectorId },
      data: { annotations: (override ?? null) as any },
    });
    if (result.count === 0) {
      throw new ForbiddenException('Tool not found');
    }

    await this.mcpServer.reloadConnectorTools(connectorId);
    const tool = await this.prisma.mcpTool.findUnique({ where: { id: toolId } });
    return {
      override,
      effective: deriveToolAnnotations({
        name: tool!.name,
        connectorType: (connector as { type: string }).type,
        endpointMapping: tool!.endpointMapping as { method?: string; path?: string },
        connectorConfig: {
          config: (connector as { config?: Record<string, unknown> | null }).config,
        },
        annotations: tool!.annotations,
      }),
    };
  }

  @Patch(':toolId/proxy')
  @ApiOperation({
    summary: 'Toggle proxy / web-unblocker routing for a single tool',
    description:
      'Sets mcp_tools.use_proxy. Takes effect only when CONNECTOR_PROXY_URL ' +
      'is configured on the instance; otherwise the request still goes out ' +
      'directly. Does not change the workspace rate limit (DB/admin only).',
  })
  async setProxy(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
    @Body() dto: SetToolProxyDto,
  ) {
    await this.assertCanWriteConnector(connectorId, req);
    const result = await this.prisma.mcpTool.updateMany({
      where: { id: toolId, connectorId },
      data: { useProxy: dto.useProxy },
    });
    if (result.count === 0) {
      throw new ForbiddenException('Tool not found');
    }
    await this.mcpServer.reloadConnectorTools(connectorId);
    return this.prisma.mcpTool.findUnique({ where: { id: toolId } });
  }

  @Post(':toolId/test')
  @ApiOperation({
    summary: 'Test an MCP tool with sample parameters',
    description:
      'Execute a tool against its connector with provided parameters. ' +
      'Accepts MCP-standard `{ arguments: {...} }` or legacy `{ params: {...} }` ' +
      '(deprecated). Returns the API response or error details.',
  })
  async testTool(
    @Param('connectorId') connectorId: string,
    @Param('toolId') toolId: string,
    @Req() req: any,
    @Body() body: TestToolDto,
  ) {
    await this.assertCanWriteConnector(connectorId, req);

    const tool = await this.prisma.mcpTool.findUnique({
      where: { id: toolId },
      include: { connector: true },
    });

    if (!tool || tool.connectorId !== connectorId) {
      return { ok: false, error: 'Tool not found' };
    }

    // MCP standard uses `arguments`; we historically accepted `params`. Take
    // `arguments` first, fall back to `params` so old clients keep working.
    const inputs = body.arguments ?? body.params ?? {};

    const startTime = Date.now();
    try {
      const result = await this.connectorsService.executeConnectorCall(
        tool.connector,
        tool.endpointMapping as any,
        inputs,
      );
      const durationMs = Date.now() - startTime;
      // Auto-fill the tool's output schema from this real response (first time
      // only). Best-effort — never let it affect the test result.
      if (!tool.outputSchema) {
        try {
          const inferred = inferJsonSchema(result);
          if (inferred) {
            await this.prisma.mcpTool.update({
              where: { id: tool.id },
              data: { outputSchema: inferred as any },
            });
            await this.mcpServer.reloadConnectorTools(connectorId);
          }
        } catch {
          /* schema inference is best-effort */
        }
      }
      return {
        ok: true,
        durationMs,
        result,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      // Return rich error details for debugging
      if (err.soapDetail) {
        return { ok: false, durationMs, ...err.soapDetail };
      }
      const { AxiosError: AxiosErr } = await import('axios');
      if (err instanceof AxiosErr && err.response) {
        const { kind, hint } = classifyToolExecutionError({
          status: err.response.status,
          authType: tool.connector.authType,
          message: err.message,
        });
        return {
          ok: false,
          durationMs,
          error: err.message,
          status: err.response.status,
          statusText: err.response.statusText,
          responseBody: err.response.data,
          kind,
          hint,
        };
      }
      const { kind, hint } = classifyToolExecutionError({
        authType: tool.connector.authType,
        message: err.message,
      });
      return {
        ok: false,
        durationMs,
        error: err.message || 'Execution failed',
        kind,
        hint,
      };
    }
  }

  @Delete(':toolId')
  @ApiOperation({ summary: 'Delete an MCP tool' })
  async remove(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
  ) {
    await this.assertCanWriteConnector(connectorId, req);
    const result = await this.prisma.mcpTool.deleteMany({
      where: { id: toolId, connectorId },
    });
    if (result.count === 0) {
      throw new ForbiddenException('Tool not found');
    }
    await this.mcpServer.reloadConnectorTools(connectorId);
    return { message: 'Tool deleted' };
  }
}
