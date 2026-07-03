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
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { PaginationQueryDto } from '../common/pagination.dto';
import { ConfigService } from '@nestjs/config';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsObject,
  IsBoolean,
  IsArray,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ConnectorType, AuthType } from '../generated/prisma/client';
import { ConnectorsService } from './connectors.service';
import { buildGraphqlBuiltinTools, slugifyForPrefix } from './graphql-builtins';
import { OpenApiParser } from './parsers/openapi.parser';
import { WsdlParser } from './parsers/wsdl.parser';
import { GraphqlParser } from './parsers/graphql.parser';
import { PostmanParser } from './parsers/postman.parser';
import { CurlParser } from './parsers/curl.parser';
import { McpClientEngine } from './engines/mcp-client.engine';
import { McpOAuthService } from './mcp-oauth.service';
import { CatalogResyncService } from './catalog-resync.service';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { getRequiredSecret } from '../common/secrets.util';
import { decrypt } from '../common/crypto/encryption.util';
import { getAdapter } from '../adapters/catalog';
import {
  interpolateDeep,
  interpolateString,
} from '../common/env-interpolation.util';

class CreateConnectorDto {
  @ApiProperty({
    description: 'Human-readable connector name shown in the UI and surfaced via MCP.',
    example: 'Acme CRM',
  })
  @IsString()
  name: string;

  @ApiProperty({
    enum: ConnectorType,
    description: 'Transport family for this connector.',
    example: 'REST',
  })
  @IsEnum(ConnectorType)
  type: ConnectorType;

  @ApiProperty({
    description: 'Root URL the engine will call. Path interpolation is applied per-tool.',
    example: 'https://api.acme.example/v1',
  })
  @IsString()
  baseUrl: string;

  @ApiPropertyOptional({
    enum: AuthType,
    description: 'Auth scheme. Omit to send no auth.',
    example: 'BEARER_TOKEN',
  })
  @IsOptional()
  @IsEnum(AuthType)
  authType?: AuthType;

  @ApiPropertyOptional({
    description:
      'Credential payload keyed by authType (e.g. { token: "..." } for BEARER_TOKEN, { username, password } for BASIC_AUTH).',
    example: { token: 'sk_live_…' },
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  authConfig?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Public URL of an OpenAPI/WSDL/GraphQL spec to associate with this connector.',
    example: 'https://api.acme.example/v1/openapi.json',
  })
  @IsOptional()
  @IsString()
  specUrl?: string;

  @ApiPropertyOptional({
    description:
      'Path appended to baseUrl when "Test connection" runs. Defaults to "/" when not set. Auto-detected from imported OpenAPI specs if /health, /healthz, /_health, /ping or /status exist.',
    example: '/health',
  })
  @IsOptional()
  @IsString()
  healthcheckPath?: string;

  @ApiPropertyOptional({
    description: 'Extra HTTP headers sent on every request.',
    example: { 'X-Tenant': 'acme' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Engine-specific options (e.g. { readOnly: true } for DATABASE connectors).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Per-connector runtime values. Referenced from tool params with `$envVarName` so the AI never has to provide them.',
    example: { ACME_TENANT_ID: '42' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Markdown notes appended to the MCP server instructions for any server that exposes this connector. Use it to tell clients about token lifetime, scopes, or quirks.',
  })
  @IsOptional()
  @IsString()
  instructions?: string;
}

class UpdateConnectorDto {
  @ApiPropertyOptional({ description: 'Human-readable connector name.' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Root URL the engine will call.' })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional({
    description: 'Path appended to baseUrl when "Test connection" runs. See CreateConnectorDto.',
  })
  @IsOptional()
  @IsString()
  healthcheckPath?: string;

  @ApiPropertyOptional({ enum: AuthType, description: 'Auth scheme.' })
  @IsOptional()
  @IsEnum(AuthType)
  authType?: AuthType;

  @ApiPropertyOptional({
    description: 'Credential payload (see CreateConnectorDto.authConfig).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  authConfig?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Set to false to disable the connector without deleting it.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Extra HTTP headers sent on every request.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Engine-specific options.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Per-connector runtime values referenced by tool params with `$name`.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Markdown notes surfaced to MCP clients.' })
  @IsOptional()
  @IsString()
  instructions?: string;
}

class ImportToolsDto {
  @ApiProperty({
    enum: ['openapi', 'wsdl', 'graphql', 'postman', 'curl', 'json', 'mcp'],
    description: 'Which parser to run on the supplied content/url.',
    example: 'openapi',
  })
  @IsString()
  source: 'openapi' | 'wsdl' | 'graphql' | 'postman' | 'curl' | 'json' | 'mcp';

  @ApiPropertyOptional({
    description: 'Inline spec content (JSON or YAML). Mutually exclusive with `url`.',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    description: 'Public URL to fetch the spec from. Mutually exclusive with `content`.',
    example: 'https://api.acme.example/v1/openapi.json',
  })
  @IsOptional()
  @IsString()
  url?: string;
}

// ── DTOs for importAll / updateEnvVars ─────────────────────────────────────

class ImportToolDto {
  @ApiProperty({ description: 'Tool name exposed via MCP (must be unique per connector).' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'One-line description shown in MCP tools/list.' })
  @IsString()
  description: string;

  @ApiPropertyOptional({ description: 'If false, the tool is registered but hidden.' })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({
    description: 'JSON Schema describing the tool input parameters.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  parameters: Record<string, unknown>;

  @ApiProperty({
    description: 'Engine-specific routing: method, path, queryParams, bodyMapping, etc.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  endpointMapping: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Optional response shaping (field selection, key rename).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  responseMapping?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: "JSON Schema of the tool's response.",
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  outputSchema?: Record<string, unknown>;
}

class ImportConnectorDto {
  @ApiProperty({ description: 'Connector name.' })
  @IsString()
  name: string;

  @ApiProperty({ enum: ConnectorType })
  @IsEnum(ConnectorType)
  type: ConnectorType;

  @ApiProperty({ description: 'Root URL.' })
  @IsString()
  baseUrl: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: AuthType })
  @IsOptional()
  @IsEnum(AuthType)
  authType?: AuthType;

  @ApiPropertyOptional({ description: 'Spec URL associated with this connector.' })
  @IsOptional()
  @IsString()
  specUrl?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  envVars?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Tools to seed under this connector. Skipped if the connector already has tools with the same names.',
    type: [ImportToolDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportToolDto)
  tools?: ImportToolDto[];
}

class ImportAllDto {
  @ApiProperty({
    description: 'Bulk-import payload: an array of connectors with their tools.',
    type: [ImportConnectorDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportConnectorDto)
  connectors: ImportConnectorDto[];
}

class UpdateEnvVarsDto {
  @ApiProperty({
    description: 'New env-var map. Replaces the existing map entirely.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { ACME_TENANT_ID: '42', ACME_API_KEY: 'sk_…' },
  })
  @IsObject()
  envVars: Record<string, string>;
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
    private readonly catalogResync: CatalogResyncService,
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
    private readonly licenseGuard: LicenseGuardService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  private readonly encryptionKey: string;

  private assertOrgMatch(connector: any, req: any) {
    if (connector.organizationId !== req.user.organizationId) {
      throw new ForbiddenException('Resource not found');
    }
  }

  private assertCanCreate(req: any) {
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot modify connectors');
    }
  }

  private assertCanWrite(connector: any, req: any) {
    this.assertOrgMatch(connector, req);
    if (req.user.role === 'VIEWER') {
      throw new ForbiddenException('Viewers cannot modify connectors');
    }
    if (connector.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the connector owner or an admin can modify this connector');
    }
  }

  @Get()
  @ApiOperation({ summary: 'List connectors for current organization' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1..200' })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async list(@Req() req: any, @Query() pagination: PaginationQueryDto) {
    return this.connectorsService.findByOrg(req.user.organizationId, {
      limit: pagination.limit,
      offset: pagination.offset,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a new connector' })
  async create(@Req() req: any, @Body() dto: CreateConnectorDto) {
    this.assertCanCreate(req);
    await this.licenseGuard.checkCanCreateConnector(req.user.sub, req.user.organizationId);
    const connector = await this.connectorsService.create(req.user.sub, req.user.organizationId, dto);

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

    // Auto-create the five generic GraphQL helper tools for every GRAPHQL
    // connector — schema_url, schema (proxy + filter), query, mutation,
    // subscription. Catalog adapters already get these via
    // adapters/catalog.ts; this branch covers user-created connectors so the
    // same out-of-the-box experience exists everywhere.
    if (dto.type === 'GRAPHQL') {
      const builtinTools = buildGraphqlBuiltinTools({
        prefix: slugifyForPrefix(dto.name),
        displayName: dto.name,
        baseUrl: dto.baseUrl,
        schemaUrl: (dto.config as { schemaUrl?: string } | undefined)?.schemaUrl,
      });
      for (const tool of builtinTools) {
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
      this.logger.log(
        `Auto-created ${builtinTools.length} generic GraphQL helper tools for connector ${connector.id}`,
      );
    }

    return connector;
  }

  @Get('proxy-availability')
  @ApiOperation({
    summary: 'Whether the proxy / web-unblocker is configured on this instance',
    description:
      'Returns { available: true } only when CONNECTOR_PROXY_URL is set. ' +
      'The UI uses this to show or hide the per-tool "Use proxy" checkbox.',
  })
  async proxyAvailability() {
    return { available: !!process.env.CONNECTOR_PROXY_URL };
  }

  @Get('health-check')
  @ApiOperation({
    summary: 'Test connectivity of all active connectors',
    description:
      'Runs a health check against all active connectors and returns their status.',
  })
  async healthCheck(@Req() req: any) {
    const allConnectors = await this.connectorsService.findByOrg(req.user.organizationId);
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
  async exportAll(@Req() req: any) {
    const allConnectors = await this.prisma.connector.findMany({
      where: { organizationId: req.user.organizationId },
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
        outputSchema: t.outputSchema,
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
    const connector = await this.connectorsService.findById(id);
    this.assertOrgMatch(connector, req);
    return connector;
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update connector' })
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateConnectorDto,
  ) {
    const connector = await this.connectorsService.findById(id);
    this.assertCanWrite(connector, req);
    return this.connectorsService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete connector' })
  async remove(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id);
    this.assertCanWrite(connector, req);
    await this.connectorsService.remove(id);
    // Unregister tools from in-memory MCP registries after DB cascade delete
    await this.mcpServer.reloadConnectorTools(id);
    return { message: 'Connector deleted' };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test connector connection' })
  async test(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id);
    this.assertCanWrite(connector, req);
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
    this.assertCanWrite(connector, req);

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
    this.assertCanWrite(connector, req);

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
        outputSchema: rt.outputSchema ?? null,
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
  async importAll(@Req() req: any, @Body() body: ImportAllDto) {
    this.assertCanCreate(req);
    if (body.connectors.length === 0) {
      return { error: 'Provide a "connectors" array with at least one connector' };
    }

    const results = { created: 0, skipped: 0, tools: 0, errors: [] as string[] };

    for (const c of body.connectors) {
      try {
        const connector = await this.prisma.connector.create({
          data: {
            userId: req.user.sub,
            organizationId: req.user.organizationId,
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
                  outputSchema: (t.outputSchema ?? null) as any,
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
    this.assertCanWrite(connector, req);

    let parsedTools: any[] = [];
    let detectedHealthcheckPath: string | undefined;

    switch (connector.type) {
      case 'REST': {
        let parsed;
        if (connector.specUrl) {
          parsed = await this.openApiParser.parseSpecFromUrl(connector.specUrl);
        } else if (connector.specData) {
          parsed = await this.openApiParser.parseSpec(connector.specData as any);
        } else {
          return { error: 'No spec URL or spec data provided for this connector' };
        }
        parsedTools = parsed.tools;
        detectedHealthcheckPath = parsed.healthcheckPath;
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

    // Auto-populate healthcheckPath the first time it's detected (only if the
    // user hasn't set one explicitly — preserves customisations on re-import).
    if (detectedHealthcheckPath && !connector.healthcheckPath) {
      await this.prisma.connector.update({
        where: { id: connector.id },
        data: { healthcheckPath: detectedHealthcheckPath },
      });
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
    this.assertCanWrite(connector, req);

    let parsedTools: any[] = [];

    let detectedHealthcheckPath: string | undefined;

    try {
      switch (dto.source) {
        case 'openapi': {
          let parsed;
          if (dto.url) {
            parsed = await this.openApiParser.parseSpecFromUrl(dto.url);
          } else if (dto.content) {
            parsed = await this.openApiParser.parseSpec(dto.content);
          } else {
            return { error: 'Provide either content or url for OpenAPI import' };
          }
          parsedTools = parsed.tools;
          detectedHealthcheckPath = parsed.healthcheckPath;
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
                outputSchema: t.outputSchema ?? null,
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
              outputSchema: rt.outputSchema ?? null,
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

    // Auto-populate healthcheckPath when first detected from an OpenAPI import,
    // preserving any explicit value the user may have set.
    if (detectedHealthcheckPath && !connector.healthcheckPath) {
      await this.prisma.connector.update({
        where: { id: connector.id },
        data: { healthcheckPath: detectedHealthcheckPath },
      });
    }

    return this.createToolsFromParsed(connector.id, parsedTools);
  }

  @Put(':id/env-vars')
  @ApiOperation({ summary: 'Update environment variables for a connector' })
  async updateEnvVars(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: UpdateEnvVarsDto,
  ) {
    const connector = await this.connectorsService.findById(id);
    this.assertCanWrite(connector, req);

    // Trim pasted values — a stray leading/trailing space would be stored
    // (and encrypted into authConfig below) verbatim and break auth with an
    // error the UI can't explain, since the displayed value looks correct.
    // Rebuild via Object.fromEntries (no dynamic user-keyed property write) so
    // a stray leading/trailing space in a pasted value can't survive into the
    // encrypted authConfig and produce a 401 the UI can't explain.
    const envVars: Record<string, string> = Object.fromEntries(
      Object.entries(body.envVars || {}).map(([k, v]) => [
        k.trim(),
        typeof v === 'string' ? v.trim() : v,
      ]),
    );

    const updateData: {
      envVars: Record<string, string>;
      authConfig?: Record<string, unknown>;
      baseUrl?: string;
      headers?: Record<string, string>;
    } = { envVars };

    // For catalog-installed connectors, authConfig/baseUrl/headers were
    // resolved from the adapter template at import time and frozen (auth
    // encrypted). Re-resolve them from the template here so editing env vars
    // actually changes the credentials used for requests — otherwise the UI
    // shows the new value while auth keeps using the old one.
    const cfg = connector.config as { adapterSlug?: string } | null;
    const adapter = cfg?.adapterSlug ? getAdapter(cfg.adapterSlug) : null;
    if (adapter) {
      const merged = {
        ...((connector.envVars as Record<string, string> | null) || {}),
        ...envVars,
      };
      if (adapter.connector.authConfig) {
        updateData.authConfig = interpolateDeep(
          adapter.connector.authConfig as Record<string, unknown>,
          merged,
        );
      }
      updateData.baseUrl = interpolateString(adapter.connector.baseUrl, merged);
      const adapterHeaders = (
        adapter.connector as { headers?: Record<string, string> }
      ).headers;
      if (adapterHeaders) {
        updateData.headers = interpolateDeep(adapterHeaders, merged);
      }
    }

    const updated = await this.connectorsService.update(id, updateData);
    await this.mcpServer.reloadConnectorTools(id);
    return updated;
  }

  @Get(':id/catalog-diff')
  @ApiOperation({
    summary:
      'Preview catalog updates for a connector installed from the catalog. ' +
      'Returns the tool diff (safe vs structural) without applying anything.',
  })
  async catalogDiff(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id);
    this.assertCanWrite(connector, req);
    const diff = await this.catalogResync.computeDiff(id);
    if (!diff) {
      return { catalogManaged: false };
    }
    return { catalogManaged: true, ...diff };
  }

  @Post(':id/resync-catalog')
  @ApiOperation({
    summary:
      'Re-sync a catalog-installed connector with the current catalog. ' +
      'Updates tool descriptions/parameters/endpoints from the catalog while ' +
      'preserving response customisations, role access and manual disables. ' +
      'Never touches credentials, base URL or env vars.',
  })
  async resyncCatalog(@Req() req: any, @Param('id') id: string) {
    const connector = await this.connectorsService.findById(id);
    this.assertCanWrite(connector, req);
    const { applied, diff } = await this.catalogResync.resync(id, 'full');
    if (applied) {
      await this.mcpServer.reloadConnectorTools(id);
    }
    return { applied, ...diff };
  }

  /**
   * Reconcile a connector's tools against a freshly parsed spec.
   *
   * Strategy:
   *   1. Snapshot existing (non-deprecated) tools for the connector.
   *   2. For each parsed tool, find a match in the snapshot — preferred
   *      lookup is by operationId, fallback is (name, method, path).
   *   3. Match found → UPDATE in place, preserving responseMapping (unless
   *      the spec now provides one) and isEnabled, and clearing
   *      deprecatedAt if it was set.
   *   4. No match → CREATE.
   *   5. Snapshot entries not matched by any parsed tool → mark
   *      deprecatedAt = now() and isEnabled = false. We do NOT hard-delete
   *      so ToolRoleAccess and ToolInvocation history survive.
   *
   * This preserves operator customisations (custom responseMapping,
   * role-based access, manual disables) across re-imports without losing
   * the visibility of "this endpoint no longer exists upstream".
   */
  private async createToolsFromParsed(connectorId: string, parsedTools: any[]) {
    const existing = await this.prisma.mcpTool.findMany({
      where: { connectorId },
    });
    const byOperationId = new Map<string, typeof existing[number]>();
    const byEndpoint = new Map<string, typeof existing[number]>();
    for (const t of existing) {
      if (t.operationId) byOperationId.set(t.operationId, t);
      const em = t.endpointMapping as any;
      if (em?.method && em?.path) {
        byEndpoint.set(`${String(em.method).toUpperCase()} ${em.path}`, t);
      }
    }

    const matchedIds = new Set<string>();
    let createdCount = 0;
    let updatedCount = 0;
    const tools: any[] = [];

    for (const tool of parsedTools) {
      const em = tool.endpointMapping as any;
      const endpointKey =
        em?.method && em?.path
          ? `${String(em.method).toUpperCase()} ${em.path}`
          : null;
      const match =
        (tool.operationId && byOperationId.get(tool.operationId)) ||
        (endpointKey && byEndpoint.get(endpointKey)) ||
        null;

      if (match) {
        matchedIds.add(match.id);
        const updated = await this.prisma.mcpTool.update({
          where: { id: match.id },
          data: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            // Preserve operator-customised responseMapping unless the spec
            // now declares one (e.g. response shaping was added upstream).
            responseMapping:
              tool.responseMapping !== undefined
                ? (tool.responseMapping as any)
                : (match.responseMapping as any),
            // Same policy for the derived output schema: refresh from the spec
            // when present, otherwise keep whatever was inferred/observed before.
            outputSchema:
              tool.outputSchema != null
                ? (tool.outputSchema as any)
                : (match.outputSchema as any),
            operationId: tool.operationId ?? match.operationId,
            deprecatedAt: null,
            // Re-enable if it was disabled only because we'd previously
            // deprecated it. If the user manually disabled it, isEnabled
            // is already false; we don't flip user choices.
            isEnabled: match.deprecatedAt ? true : match.isEnabled,
          },
        });
        tools.push(updated);
        updatedCount++;
        continue;
      }

      try {
        const created = await this.prisma.mcpTool.create({
          data: {
            connectorId,
            name: tool.name,
            description: tool.description,
            operationId: tool.operationId ?? null,
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            responseMapping: tool.responseMapping as any,
            outputSchema: (tool.outputSchema ?? null) as any,
          },
        });
        tools.push(created);
        createdCount++;
      } catch (err: any) {
        // A different existing tool happens to share the new tool's name
        // (e.g. same name across two re-imports on parametric paths).
        // Skip rather than throw — preserves prior semantics.
        if (err.code !== 'P2002') throw err;
      }
    }

    // Tools that survived the parse but are no longer in the spec.
    const now = new Date();
    const deprecated: string[] = [];
    for (const t of existing) {
      if (matchedIds.has(t.id)) continue;
      if (t.deprecatedAt) continue; // already deprecated
      await this.prisma.mcpTool.update({
        where: { id: t.id },
        data: { deprecatedAt: now, isEnabled: false },
      });
      deprecated.push(t.name);
    }

    await this.mcpServer.reloadConnectorTools(connectorId);

    const parts = [`created ${createdCount}`, `updated ${updatedCount}`];
    if (deprecated.length > 0) parts.push(`deprecated ${deprecated.length}`);
    return {
      message: `Imported tools: ${parts.join(', ')}`,
      tools,
      created: createdCount,
      updated: updatedCount,
      deprecated,
      // `skipped` kept for back-compat with clients that consumed the old
      // shape; always empty under the new upsert strategy.
      skipped: [] as string[],
    };
  }
}
