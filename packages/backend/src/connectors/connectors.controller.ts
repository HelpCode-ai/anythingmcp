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
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
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
import { McpClientEngine } from './engines/mcp-client.engine';
import { McpOAuthService } from './mcp-oauth.service';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { decrypt } from '../common/crypto/encryption.util';

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

  @IsOptional()
  @IsString()
  instructions?: string;
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

  @IsOptional()
  @IsString()
  instructions?: string;
}

class ImportToolsDto {
  @IsString()
  source: 'openapi' | 'wsdl' | 'graphql' | 'postman' | 'curl' | 'json' | 'mcp';

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
    private readonly mcpClientEngine: McpClientEngine,
    private readonly mcpOAuthService: McpOAuthService,
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
    private readonly licenseGuard: LicenseGuardService,
  ) {
    this.encryptionKey =
      this.configService.get<string>('ENCRYPTION_KEY') ||
      'default-dev-key-change-in-prod!!';
  }

  private readonly encryptionKey: string;

  private assertOwnerOrAdmin(connector: any, req: any) {
    if (connector.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the connector owner or an admin can modify this connector');
    }
  }

  @Get()
  @ApiOperation({ summary: 'List all connectors' })
  async list() {
    return this.connectorsService.findAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new connector' })
  async create(@Req() req: any, @Body() dto: CreateConnectorDto) {
    await this.licenseGuard.checkCanCreateConnector(req.user.sub);
    const connector = await this.connectorsService.create(req.user.sub, dto);

    // Auto-create default tools for DATABASE connectors
    if (dto.type === 'DATABASE') {
      const readOnly = (dto.config as any)?.readOnly !== false;
      const defaultTools = this.connectorsService.generateDefaultDatabaseTools(dto.baseUrl, readOnly);
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
  async healthCheck() {
    const allConnectors = await this.connectorsService.findAll();
    const active = allConnectors.filter((c) => c.isActive);

    const results = await Promise.allSettled(
      active.map(async (c) => {
        const start = Date.now();
        try {
          const result = await this.connectorsService.testConnection(c.id);
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
  async exportAll() {
    const allConnectors = await this.prisma.connector.findMany({
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
  async findOne(@Param('id') id: string) {
    return this.connectorsService.findById(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update connector' })
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateConnectorDto,
  ) {
    const connector = await this.connectorsService.findById(id);
    this.assertOwnerOrAdmin(connector, req);
    return this.connectorsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete connector' })
  async remove(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id);
    this.assertOwnerOrAdmin(connector, req);
    await this.connectorsService.remove(id);
    // Unregister tools from in-memory MCP registries after DB cascade delete
    await this.mcpServer.reloadConnectorTools(id);
    return { message: 'Connector deleted' };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test connector connection' })
  async test(@Param('id') id: string) {
    return this.connectorsService.testConnection(id);
  }

  @Post(':id/oauth/authorize')
  @ApiOperation({
    summary: 'Initiate OAuth2 authorization for a connector',
    description:
      'For MCP connectors: discovers OAuth endpoints via .well-known and optionally registers dynamically. ' +
      'For REST/GraphQL connectors: uses authorizationUrl and tokenUrl from authConfig. ' +
      'Returns an authorization URL for the user to visit.',
  })
  async initiateOAuth(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id);
    this.assertOwnerOrAdmin(connector, req);

    if (connector.authType !== 'OAUTH2') {
      return { error: 'Connector auth type must be OAUTH2' };
    }

    try {
      const callbackUrl = `${this.configService.get('SERVER_URL') || 'http://localhost:4000'}/api/mcp-oauth/callback`;
      const authConfig = connector.authConfig
        ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey))
        : {};

      let clientId: string;
      let clientSecret: string | undefined;
      let authorizationEndpoint: string;
      let tokenEndpoint: string;
      let scope: string | undefined;

      if (connector.type === 'MCP') {
        // MCP: discover OAuth metadata from remote server
        const metadata = await this.mcpOAuthService.discoverMetadata(connector.baseUrl);
        this.logger.log(`OAuth metadata discovered from ${connector.baseUrl}: issuer=${metadata.issuer}`);

        authorizationEndpoint = metadata.authorization_endpoint;
        tokenEndpoint = metadata.token_endpoint;
        scope = metadata.scopes_supported?.join(' ');

        if (metadata.registration_endpoint) {
          const registration = await this.mcpOAuthService.registerClient(
            metadata.registration_endpoint,
            callbackUrl,
          );
          clientId = registration.clientId;
          clientSecret = registration.clientSecret;
        } else {
          clientId = String(authConfig.clientId || '');
          clientSecret = authConfig.clientSecret ? String(authConfig.clientSecret) : undefined;
        }
      } else {
        // REST/GraphQL: use authConfig values directly
        clientId = String(authConfig.clientId || '');
        clientSecret = authConfig.clientSecret ? String(authConfig.clientSecret) : undefined;
        authorizationEndpoint = String(authConfig.authorizationUrl || '');
        tokenEndpoint = String(authConfig.tokenUrl || '');
        scope = authConfig.scopes ? String(authConfig.scopes) : undefined;
      }

      if (!clientId) {
        return { error: 'No clientId configured for this connector' };
      }
      if (!authorizationEndpoint) {
        return { error: 'No authorization URL configured for this connector' };
      }

      // Generate PKCE challenge
      const codeVerifier = this.mcpOAuthService.generateCodeVerifier();
      const codeChallenge = this.mcpOAuthService.generateCodeChallenge(codeVerifier);
      const state = this.mcpOAuthService.generateState();

      // Store pending flow
      this.mcpOAuthService.storePendingFlow(state, {
        codeVerifier,
        connectorId: connector.id,
        userId: req.user.sub,
        redirectUri: callbackUrl,
        clientId,
        clientSecret,
        tokenUrl: tokenEndpoint,
        createdAt: Date.now(),
      });

      // Build authorization URL
      const authorizationUrl = this.mcpOAuthService.buildAuthorizationUrl({
        authorizationEndpoint,
        clientId,
        redirectUri: callbackUrl,
        codeChallenge,
        state,
        scope,
      });

      return { authorizationUrl };
    } catch (error: any) {
      this.logger.error(`OAuth initiation failed for connector ${id}: ${error.message}`);
      return { error: `OAuth initiation failed: ${error.message}` };
    }
  }

  @Post(':id/discover-tools')
  @ApiOperation({
    summary: 'Discover and import tools from a remote MCP server',
    description:
      'Connects to the remote MCP server using stored credentials, ' +
      'lists all available tools, and imports them as MCP tools.',
  })
  async discoverMcpTools(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id);
    this.assertOwnerOrAdmin(connector, req);

    if (connector.type !== 'MCP') {
      return { error: 'Tool discovery is only available for MCP connectors' };
    }

    try {
      const authConfig = connector.authConfig
        ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey))
        : undefined;

      const remoteTools = await this.mcpClientEngine.listTools({
        baseUrl: connector.baseUrl,
        authType: connector.authType,
        authConfig,
        headers: connector.headers as Record<string, string>,
      });

      const parsedTools = remoteTools.map((rt) => ({
        name: rt.name,
        description: rt.description || `MCP tool: ${rt.name}`,
        parameters: rt.inputSchema || { type: 'object', properties: {} },
        endpointMapping: {
          method: rt.name,
          path: '/mcp',
        },
      }));

      return this.createToolsFromParsed(connector.id, parsedTools);
    } catch (error: any) {
      this.logger.error(`Tool discovery failed for connector ${id}: ${error.message}`);
      return { error: `Tool discovery failed: ${error.message}` };
    }
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
    const connector = await this.connectorsService.findById(id);
    this.assertOwnerOrAdmin(connector, req);

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
        parsedTools = await this.graphqlParser.parse(
          connector.baseUrl, headers || undefined, connector.specUrl || undefined,
        );
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
    const connector = await this.connectorsService.findById(id);
    this.assertOwnerOrAdmin(connector, req);

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
          parsedTools = await this.graphqlParser.parse(
            endpoint, headers || undefined, dto.url || undefined,
          );
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
        case 'mcp': {
          if (connector.type !== 'MCP') {
            return { error: 'MCP import source is only available for MCP connectors' };
          }
          const authConfig = connector.authConfig
            ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey))
            : undefined;
          const remoteTools = await this.mcpClientEngine.listTools({
            baseUrl: connector.baseUrl,
            authType: connector.authType,
            authConfig,
            headers: connector.headers as Record<string, string>,
            mcpPath: dto.url || '/mcp',
          });
          for (const rt of remoteTools) {
            parsedTools.push({
              name: rt.name,
              description: rt.description || `MCP tool: ${rt.name}`,
              parameters: rt.inputSchema || { type: 'object', properties: {} },
              endpointMapping: {
                method: rt.name,
                path: dto.url || '/mcp',
              },
            });
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
    const connector = await this.connectorsService.findById(id);
    this.assertOwnerOrAdmin(connector, req);
    const updated = await this.connectorsService.update(id, {
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
