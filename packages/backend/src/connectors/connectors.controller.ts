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
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsBoolean,
} from 'class-validator';
import { ConnectorType, AuthType } from '../generated/prisma/client';
import { ConnectorsService } from './connectors.service';
import { OpenApiParser } from './parsers/openapi.parser';
import { WsdlParser } from './parsers/wsdl.parser';
import { GraphqlParser } from './parsers/graphql.parser';
import { PostmanParser } from './parsers/postman.parser';
import { CurlParser } from './parsers/curl.parser';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';

class CreateConnectorDto {
  @IsString()
  name: string;

  @IsEnum(ConnectorType)
  type: ConnectorType;

  @IsString()
  baseUrl: string;

  @IsOptional()
  @IsEnum(AuthType)
  authType?: AuthType;

  @IsOptional()
  @IsObject()
  authConfig?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  specUrl?: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;
}

class UpdateConnectorDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsEnum(AuthType)
  authType?: AuthType;

  @IsOptional()
  @IsObject()
  authConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;
}

class ImportToolsDto {
  @IsString()
  source: 'openapi' | 'wsdl' | 'graphql' | 'postman' | 'curl' | 'json';

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  url?: string;
}

@ApiTags('Connectors')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('api/connectors')
export class ConnectorsController {
  private readonly logger = new Logger(ConnectorsController.name);

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly openApiParser: OpenApiParser,
    private readonly wsdlParser: WsdlParser,
    private readonly graphqlParser: GraphqlParser,
    private readonly postmanParser: PostmanParser,
    private readonly curlParser: CurlParser,
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all connectors for the current user' })
  async list(@Req() req: any) {
    return this.connectorsService.findAllByUser(req.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new connector' })
  async create(@Req() req: any, @Body() dto: CreateConnectorDto) {
    const connector = await this.connectorsService.create(req.user.sub, dto);

    // Auto-create default tools for DATABASE connectors
    if (dto.type === 'DATABASE') {
      const defaultTools = this.connectorsService.generateDefaultDatabaseTools(dto.baseUrl);
      for (const tool of defaultTools) {
        try {
          await this.prisma.mcpTool.create({
            data: {
              connectorId: connector.id,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters as any,
              endpointMapping: tool.endpointMapping as any,
            },
          });
        } catch (err: any) {
          if (err.code !== 'P2002') throw err; // skip duplicates
        }
      }
      await this.mcpServer.reloadConnectorTools(connector.id);
      this.logger.log(`Auto-created ${defaultTools.length} default tools for DATABASE connector ${connector.id}`);
    }

    return connector;
  }

  @Get('health-check')
  @ApiOperation({
    summary: 'Test connectivity of all active connectors',
    description:
      'Runs a health check against all active connectors and returns their status.',
  })
  async healthCheck(@Req() req: any) {
    const allConnectors = await this.connectorsService.findAllByUser(req.user.sub);
    const active = allConnectors.filter((c) => c.isActive);

    const results = await Promise.allSettled(
      active.map(async (c) => {
        const start = Date.now();
        try {
          const result = await this.connectorsService.testConnection(c.id, req.user.sub);
          return {
            id: c.id,
            name: c.name,
            type: c.type,
            status: result.ok ? 'healthy' : 'unhealthy',
            message: result.message,
            latencyMs: Date.now() - start,
          };
        } catch (err: any) {
          return {
            id: c.id,
            name: c.name,
            type: c.type,
            status: 'unhealthy',
            message: err.message,
            latencyMs: Date.now() - start,
          };
        }
      }),
    );

    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? r.value : { status: 'error', message: 'Check failed' },
    );

    const healthy = statuses.filter((s: any) => s.status === 'healthy').length;

    return {
      total: active.length,
      healthy,
      unhealthy: active.length - healthy,
      connectors: statuses,
    };
  }

  @Get('export-all')
  @ApiOperation({
    summary: 'Export all connectors and tools as JSON for backup/migration',
    description:
      'Returns all connectors with their tools, environment variables, ' +
      'and configuration. Auth credentials are excluded for security.',
  })
  async exportAll(@Req() req: any) {
    const allConnectors = await this.prisma.connector.findMany({
      where: { userId: req.user.sub },
      include: { tools: true },
    });

    const exportData = allConnectors.map((c) => ({
      name: c.name,
      type: c.type,
      baseUrl: c.baseUrl,
      isActive: c.isActive,
      authType: c.authType,
      specUrl: c.specUrl,
      headers: c.headers,
      config: c.config,
      envVars: c.envVars,
      tools: c.tools.map((t) => ({
        name: t.name,
        description: t.description,
        isEnabled: t.isEnabled,
        parameters: t.parameters,
        endpointMapping: t.endpointMapping,
        responseMapping: t.responseMapping,
      })),
    }));

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      connectors: exportData,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get connector details' })
  async findOne(@Req() req: any, @Param('id') id: string) {
    return this.connectorsService.findById(id, req.user.sub);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update connector' })
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateConnectorDto,
  ) {
    return this.connectorsService.update(id, req.user.sub, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete connector' })
  async remove(@Req() req: any, @Param('id') id: string) {
    await this.connectorsService.remove(id, req.user.sub);
    // Unregister tools from in-memory MCP registries after DB cascade delete
    await this.mcpServer.reloadConnectorTools(id);
    return { message: 'Connector deleted' };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test connector connection' })
  async test(@Req() req: any, @Param('id') id: string) {
    return this.connectorsService.testConnection(id, req.user.sub);
  }

  @Post('import-all')
  @ApiOperation({
    summary: 'Import connectors and tools from a backup JSON',
    description:
      'Import a previously exported configuration. Skips connectors ' +
      'with duplicate names. Does not import auth credentials.',
  })
  async importAll(@Req() req: any, @Body() body: { connectors: any[] }) {
    if (!Array.isArray(body.connectors) || body.connectors.length === 0) {
      return { error: 'Provide a "connectors" array with at least one connector' };
    }

    const results = { created: 0, skipped: 0, tools: 0, errors: [] as string[] };

    for (const c of body.connectors) {
      try {
        const connector = await this.prisma.connector.create({
          data: {
            userId: req.user.sub,
            name: c.name,
            type: c.type,
            baseUrl: c.baseUrl,
            isActive: c.isActive ?? true,
            authType: c.authType || 'NONE',
            specUrl: c.specUrl,
            headers: c.headers as any,
            config: c.config as any,
            envVars: c.envVars as any,
          },
        });
        results.created++;

        if (Array.isArray(c.tools)) {
          for (const t of c.tools) {
            try {
              await this.prisma.mcpTool.create({
                data: {
                  connectorId: connector.id,
                  name: t.name,
                  description: t.description,
                  isEnabled: t.isEnabled ?? true,
                  parameters: t.parameters as any,
                  endpointMapping: t.endpointMapping as any,
                  responseMapping: t.responseMapping as any,
                },
              });
              results.tools++;
            } catch (err: any) {
              if (err.code !== 'P2002') {
                results.errors.push(`Tool ${t.name}: ${err.message}`);
              }
            }
          }
          await this.mcpServer.reloadConnectorTools(connector.id);
        }
      } catch (err: any) {
        if (err.code === 'P2002') {
          results.skipped++;
        } else {
          results.errors.push(`Connector ${c.name}: ${err.message}`);
        }
      }
    }

    return {
      message: `Imported ${results.created} connectors with ${results.tools} tools${results.skipped > 0 ? `, skipped ${results.skipped} duplicates` : ''}`,
      ...results,
    };
  }

  @Post(':id/import-spec')
  @ApiOperation({ summary: 'Auto-generate MCP tools from API specification' })
  async importSpec(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id, req.user.sub);

    let parsedTools: any[] = [];

    switch (connector.type) {
      case 'REST': {
        if (connector.specUrl) {
          parsedTools = await this.openApiParser.parseFromUrl(connector.specUrl);
        } else if (connector.specData) {
          parsedTools = await this.openApiParser.parse(connector.specData as any);
        } else {
          return { error: 'No spec URL or spec data provided for this connector' };
        }
        break;
      }
      case 'SOAP': {
        const wsdlUrl = connector.specUrl || connector.baseUrl;
        parsedTools = await this.wsdlParser.parse(wsdlUrl);
        break;
      }
      case 'GRAPHQL': {
        const headers = connector.headers as Record<string, string> | undefined;
        parsedTools = await this.graphqlParser.parse(connector.baseUrl, headers || undefined);
        break;
      }
      default:
        return { error: `Spec import not supported for ${connector.type} connectors` };
    }

    return this.createToolsFromParsed(connector.id, parsedTools);
  }

  @Post(':id/import')
  @ApiOperation({
    summary: 'Import tools from any source: OpenAPI, Postman, cURL, WSDL, GraphQL',
  })
  async importTools(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ImportToolsDto,
  ) {
    const connector = await this.connectorsService.findById(id, req.user.sub);

    let parsedTools: any[] = [];

    try {
      switch (dto.source) {
        case 'openapi': {
          if (dto.url) {
            parsedTools = await this.openApiParser.parseFromUrl(dto.url);
          } else if (dto.content) {
            parsedTools = await this.openApiParser.parse(dto.content);
          } else {
            return { error: 'Provide either content or url for OpenAPI import' };
          }
          break;
        }
        case 'wsdl': {
          const wsdlUrl = dto.url || dto.content || connector.baseUrl;
          parsedTools = await this.wsdlParser.parse(wsdlUrl);
          break;
        }
        case 'graphql': {
          const headers = connector.headers as Record<string, string> | undefined;
          const endpoint = dto.url || connector.baseUrl;
          parsedTools = await this.graphqlParser.parse(endpoint, headers || undefined);
          break;
        }
        case 'postman': {
          if (dto.url) {
            parsedTools = await this.postmanParser.parseFromUrl(dto.url);
          } else if (dto.content) {
            parsedTools = await this.postmanParser.parseFromContent(dto.content);
          } else {
            return { error: 'Provide either content (JSON) or url for Postman import' };
          }
          break;
        }
        case 'curl': {
          if (!dto.content) {
            return { error: 'Provide the cURL command(s) in content field' };
          }
          parsedTools = this.curlParser.parse(dto.content);
          break;
        }
        case 'json': {
          if (!dto.content) {
            return { error: 'Provide the JSON tool definitions in content field' };
          }
          try {
            const parsed = JSON.parse(dto.content);
            const toolArray = Array.isArray(parsed) ? parsed : parsed.tools || [parsed];
            for (const t of toolArray) {
              if (!t.name || !t.description || !t.endpointMapping) {
                return {
                  error: `Invalid tool definition: each tool must have "name", "description", and "endpointMapping". Got keys: ${Object.keys(t).join(', ')}`,
                };
              }
              parsedTools.push({
                name: t.name,
                description: t.description,
                parameters: t.parameters || { type: 'object', properties: {} },
                endpointMapping: t.endpointMapping,
                responseMapping: t.responseMapping,
              });
            }
          } catch (e: any) {
            return { error: `Invalid JSON: ${e.message}` };
          }
          break;
        }
        default:
          return { error: `Unknown import source: ${dto.source}` };
      }
    } catch (err: any) {
      this.logger.warn(`Import failed for connector ${id}: ${err.message}`);
      return { error: `Import failed: ${err.message}` };
    }

    return this.createToolsFromParsed(connector.id, parsedTools);
  }

  @Put(':id/env-vars')
  @ApiOperation({ summary: 'Update environment variables for a connector' })
  async updateEnvVars(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { envVars: Record<string, string> },
  ) {
    const updated = await this.connectorsService.update(id, req.user.sub, {
      envVars: body.envVars,
    });
    await this.mcpServer.reloadConnectorTools(id);
    return updated;
  }

  private async createToolsFromParsed(connectorId: string, parsedTools: any[]) {
    const createdTools = [];
    const skippedTools: string[] = [];

    for (const tool of parsedTools) {
      try {
        const created = await this.prisma.mcpTool.create({
          data: {
            connectorId,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            responseMapping: tool.responseMapping as any,
          },
        });
        createdTools.push(created);
      } catch (err: any) {
        // Skip duplicate tools (unique constraint on [connectorId, name])
        if (err.code === 'P2002') {
          skippedTools.push(tool.name);
        } else {
          throw err;
        }
      }
    }

    await this.mcpServer.reloadConnectorTools(connectorId);

    return {
      message: `Imported ${createdTools.length} tools${skippedTools.length > 0 ? `, skipped ${skippedTools.length} duplicates` : ''}`,
      tools: createdTools,
      skipped: skippedTools,
    };
  }
}
