import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  ForbiddenException,
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
        return {
          ok: false,
          durationMs,
          error: err.message,
          status: err.response.status,
          statusText: err.response.statusText,
          responseBody: err.response.data,
        };
      }
      return {
        ok: false,
        durationMs,
        error: err.message || 'Execution failed',
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
