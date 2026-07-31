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
  applyResponseTransform,
  hasTransform,
  validateTransform,
} from './response-transform.util';
import {
  ToolAnnotations,
  deriveToolAnnotations,
  parseAnnotationsOverride,
} from '../mcp-server/tool-annotations';
import {
  CALLER_CONTEXT_VARIABLES,
  findUnknownCallerContextVars,
  usesCallerContextDeep,
} from '../common/caller-context.util';

const RESPONSE_MAPPING_DESC =
  'Optional response handling for this tool. Keys: `cacheTtl` (seconds), ' +
  '`followUp` (workflow hint appended to the result) and `transform` — the ' +
  'response shaping applied before the result reaches the MCP client. ' +
  '`transform` accepts `include` / `exclude` (path lists, shape preserved), ' +
  '`select` (output template: leaves are paths like `$.a.b`, `= literal` for ' +
  'static values, `{ $from, $select }` to reshape array elements), ' +
  '`expression` with `mode: "jmespath"`, `fallbackToRaw` (default true) and ' +
  '`maxBytes`. Omit `transform` and the raw upstream response is returned ' +
  'unchanged.';

const RESPONSE_MAPPING_EXAMPLE = {
  transform: {
    select: {
      page: { count: '$.pageDetails.count', totalCount: '$.pageDetails.totalCount' },
      devices: {
        $from: '$.devices[*]',
        $select: {
          id: 'id',
          hostname: 'hostname',
          category: 'deviceType.category',
          antivirusStatus: 'antivirus.antivirusStatus',
        },
      },
    },
  },
};

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
    description: RESPONSE_MAPPING_DESC,
    type: 'object',
    additionalProperties: true,
    example: RESPONSE_MAPPING_EXAMPLE,
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
    description: RESPONSE_MAPPING_DESC,
    type: 'object',
    additionalProperties: true,
    example: RESPONSE_MAPPING_EXAMPLE,
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

  @ApiPropertyOptional({
    description:
      'Response transform to preview for this run, overriding the one stored on ' +
      'the tool. Lets the editor try an unsaved mapping against a live response. ' +
      'The stored mapping is not modified.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  transform?: Record<string, unknown>;
}

class SetResponseMappingDto {
  @ApiPropertyOptional({
    description:
      'The response transform to store. Send `null` to remove it and go back to ' +
      'returning the raw upstream response. `cacheTtl` and `followUp` on the ' +
      'tool are preserved.',
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: RESPONSE_MAPPING_EXAMPLE.transform,
  })
  @IsOptional()
  @IsObject()
  transform?: Record<string, unknown> | null;
}

class PreviewMappingDto {
  @ApiPropertyOptional({
    description:
      'The transform to evaluate. Defaults to the one stored on the tool.',
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  transform?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Sample response to map. When omitted, the most recent real response ' +
      'recorded for this tool is used.',
  })
  @IsOptional()
  sample?: unknown;
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

  /**
   * Reject a malformed response transform at save time. Left to runtime it
   * would silently fall back to the raw response, which reads as "the mapping
   * does nothing" — the hardest kind of bug to diagnose from the UI.
   */
  private assertValidResponseMapping(responseMapping: unknown) {
    if (!responseMapping || typeof responseMapping !== 'object') return;
    const transform = (responseMapping as Record<string, unknown>).transform;
    if (transform === undefined || transform === null) return;
    const error = validateTransform(transform);
    if (error) {
      throw new BadRequestException(`Invalid response mapping: ${error}`);
    }
  }

  /**
   * Most recent real response recorded for a tool, used as the sample for the
   * mapping preview. Scans the last few successful invocations rather than
   * filtering on JSON null in SQL: `output` is only null for older rows, and a
   * small scan keeps the query portable.
   */
  private async findLatestSample(
    toolId: string,
  ): Promise<{ output: unknown; createdAt: Date } | null> {
    const recent = await this.prisma.toolInvocation.findMany({
      where: { toolId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { output: true, createdAt: true },
    });
    const hit = recent.find((r) => r.output !== null && r.output !== undefined);
    return hit ? { output: hit.output, createdAt: hit.createdAt } : null;
  }

  private static byteLength(value: unknown): number {
    try {
      const json = JSON.stringify(value);
      return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
    } catch {
      return 0;
    }
  }

  /**
   * Summary of what a transform did to a response, shared by the test and
   * preview endpoints so the UI can render the same "12.4 KB → 0.9 KB (−93%)"
   * badge in both places.
   */
  private static mappingSummary(raw: unknown, mapping: unknown) {
    const outcome = applyResponseTransform(raw, mapping as any);
    const rawBytes = ToolsController.byteLength(raw);
    const mappedBytes = outcome.applied
      ? ToolsController.byteLength(outcome.value)
      : rawBytes;
    return {
      mapped: outcome.value,
      mappingApplied: outcome.applied,
      ...(outcome.error ? { mappingError: outcome.error } : {}),
      ...(outcome.truncated ? { mappingTruncated: true } : {}),
      rawBytes,
      mappedBytes,
      bytesSavedPct:
        rawBytes > 0 ? Math.round(((rawBytes - mappedBytes) / rawBytes) * 100) : 0,
    };
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
    this.assertValidResponseMapping(dto.responseMapping);
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
      this.assertValidResponseMapping(dto.responseMapping);
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
    if (dto.responseMapping !== undefined) {
      this.assertValidResponseMapping(dto.responseMapping);
    }

    // A changed transform changes the shape clients receive, so the stored
    // outputSchema (inferred from the previous shape) no longer describes it.
    // Drop it and let the next successful test re-infer it.
    const data: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
    if (dto.responseMapping !== undefined) {
      const current = await this.prisma.mcpTool.findFirst({
        where: { id: toolId, connectorId },
        select: { responseMapping: true },
      });
      const before = JSON.stringify(
        (current?.responseMapping as Record<string, unknown> | null)?.transform ?? null,
      );
      const after = JSON.stringify(dto.responseMapping?.transform ?? null);
      if (before !== after) data.outputSchema = null;
    }

    // Bind the toolId to the connectorId in the WHERE clause so that
    // a request like /connectors/<my>/tools/<other-org's-tool> cannot
    // update a tool that doesn't belong to the requested connector.
    const result = await this.prisma.mcpTool.updateMany({
      where: { id: toolId, connectorId },
      data: data as any,
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

  @Get(':toolId/response-mapping')
  @ApiOperation({
    summary: 'Get the response mapping configured for a tool',
    description:
      'Returns the stored `transform` (or null), whether it is active, and ' +
      'whether a recent real response is available to preview it against.',
  })
  async getResponseMapping(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
  ) {
    await this.assertCanWriteConnector(connectorId, req);
    const tool = await this.prisma.mcpTool.findFirst({
      where: { id: toolId, connectorId },
      select: { responseMapping: true },
    });
    if (!tool) throw new ForbiddenException('Tool not found');

    const responseMapping = tool.responseMapping as Record<string, unknown> | null;
    const lastSample = await this.findLatestSample(toolId);

    return {
      transform: (responseMapping?.transform as Record<string, unknown>) ?? null,
      active: hasTransform(responseMapping),
      sampleAvailable: !!lastSample,
      sampleCapturedAt: lastSample?.createdAt ?? null,
    };
  }

  @Patch(':toolId/response-mapping')
  @ApiOperation({
    summary: 'Set or clear the response mapping for a tool',
    description:
      'Stores `responseMapping.transform` without touching `cacheTtl` or ' +
      '`followUp`. Response mapping shrinks what an MCP client receives — ' +
      'fewer tokens, and only the fields the tool actually needs leave the ' +
      'workspace. Send `transform: null` to go back to the raw response. ' +
      'A malformed transform is rejected here rather than silently ignored at ' +
      'call time.',
  })
  async setResponseMapping(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
    @Body() dto: SetResponseMappingDto,
  ) {
    await this.assertCanWriteConnector(connectorId, req);

    const tool = await this.prisma.mcpTool.findFirst({
      where: { id: toolId, connectorId },
      select: { responseMapping: true },
    });
    if (!tool) throw new ForbiddenException('Tool not found');

    if (dto.transform) {
      const error = validateTransform(dto.transform);
      if (error) throw new BadRequestException(`Invalid response mapping: ${error}`);
    }

    // Merge, so cacheTtl / followUp survive a mapping edit.
    const current = (tool.responseMapping as Record<string, unknown> | null) ?? {};
    const next: Record<string, unknown> = { ...current };
    if (dto.transform) {
      next.transform = dto.transform;
    } else {
      delete next.transform;
    }

    await this.prisma.mcpTool.updateMany({
      where: { id: toolId, connectorId },
      data: {
        responseMapping: (Object.keys(next).length > 0 ? next : null) as any,
        // The advertised outputSchema described the previous shape.
        outputSchema: null as any,
      },
    });

    await this.mcpServer.reloadConnectorTools(connectorId);
    return {
      transform: dto.transform ?? null,
      active: hasTransform(next),
    };
  }

  @Post(':toolId/preview-mapping')
  @ApiOperation({
    summary: 'Preview a response mapping without calling the upstream API',
    description:
      'Runs a transform against a sample response and returns the mapped ' +
      'result plus the size delta. With no `sample`, the most recent real ' +
      'response recorded for this tool is used — so a mapping can be built and ' +
      'checked against production-shaped data without hitting the API again. ' +
      'Purely read-only: nothing is stored.',
  })
  async previewMapping(
    @Req() req: any,
    @Param('toolId') toolId: string,
    @Param('connectorId') connectorId: string,
    @Body() dto: PreviewMappingDto,
  ) {
    await this.assertCanWriteConnector(connectorId, req);

    const tool = await this.prisma.mcpTool.findFirst({
      where: { id: toolId, connectorId },
      select: { responseMapping: true },
    });
    if (!tool) throw new ForbiddenException('Tool not found');

    if (dto.transform) {
      const error = validateTransform(dto.transform);
      if (error) throw new BadRequestException(`Invalid response mapping: ${error}`);
    }

    let sample = dto.sample;
    let sampleSource: 'body' | 'last-invocation' | 'none' = 'body';
    let sampleCapturedAt: Date | null = null;

    if (sample === undefined) {
      const last = await this.findLatestSample(toolId);
      if (!last) {
        return {
          ok: false,
          sampleSource: 'none' as const,
          error:
            'No sample available. Run the tool once (Test, or from a connected ' +
            'client), or pass a `sample` in the request body.',
        };
      }
      sample = last.output;
      sampleSource = 'last-invocation';
      sampleCapturedAt = last.createdAt;
    }

    // An explicit `transform: null` previews "no mapping"; omitting the key
    // previews whatever is stored on the tool.
    const mapping =
      dto.transform !== undefined
        ? dto.transform === null
          ? null
          : { transform: dto.transform }
        : (tool.responseMapping as Record<string, unknown> | null);

    return {
      ok: true,
      sampleSource,
      sampleCapturedAt,
      raw: sample,
      ...ToolsController.mappingSummary(sample, mapping),
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

    // This runs from the admin UI, not through an authenticated MCP session,
    // so {{amcp.*}} resolves to empty here and the result can differ from a
    // real call. Say so rather than letting it look like a broken tool.
    const callerContextNote = usesCallerContextDeep(tool.endpointMapping)
      ? 'This tool uses caller-context variables ({{amcp.*}}). They resolve to ' +
        'empty in this test because it does not run through an authenticated ' +
        'MCP session — run it from a connected client to see the real result.'
      : undefined;

    const startTime = Date.now();
    try {
      const result = await this.connectorsService.executeConnectorCall(
        tool.connector,
        tool.endpointMapping as any,
        inputs,
      );
      const durationMs = Date.now() - startTime;
      const withNote = callerContextNote ? { note: callerContextNote } : {};

      // Shape the response the same way a real MCP call would. `result` stays
      // the raw upstream payload so existing API consumers are unaffected; the
      // mapped view is additive. An unsaved `transform` in the body wins, so
      // the editor can try a mapping before committing to it.
      const mapping = body.transform
        ? { transform: body.transform }
        : (tool.responseMapping as Record<string, unknown> | null);
      const summary = ToolsController.mappingSummary(result, mapping);

      // Auto-fill the tool's output schema from this real response (first time
      // only). Infer from the mapped shape when a mapping is active, so the
      // advertised schema describes what clients actually receive.
      // Best-effort — never let it affect the test result.
      if (!tool.outputSchema) {
        try {
          const inferred = inferJsonSchema(
            summary.mappingApplied ? summary.mapped : result,
          );
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
        ...summary,
        ...withNote,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const withNote = callerContextNote ? { note: callerContextNote } : {};
      // Return rich error details for debugging. Deliberately left untouched:
      // spreading anything extra here makes CodeQL attribute its pre-existing
      // js/reflected-xss finding on `err.soapDetail` to whichever PR edits the
      // line. That pattern deserves its own assessment, not a silent ride-along
      // (the response is JSON and React escapes it, so it is not exploitable
      // today). The caller-context note is still returned on every other path.
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
          ...withNote,
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
        ...withNote,
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
