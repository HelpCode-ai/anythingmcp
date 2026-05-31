import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { McpRegistryService } from '@rekog/mcp-nest';
import { PrismaService } from '../common/prisma.service';
import { decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { ToolRegistry } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { RolesService } from '../roles/roles.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';

@Injectable()
export class McpServerService implements OnModuleInit {
  private readonly logger = new Logger(McpServerService.name);
  private mcpRegistry!: McpRegistryService;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: DynamicMcpTools,
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
    private readonly rolesService: RolesService,
    private readonly mcpServersService: McpServersService,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  async onModuleInit() {
    // Resolve McpRegistryService from the global app context
    // (it's exported by McpModule.forRoot() in AppModule)
    this.mcpRegistry = this.moduleRef.get(McpRegistryService, {
      strict: false,
    });

    this.logger.log('Initializing dynamic MCP server...');
    await this.loadAllTools();
    this.logger.log(
      `MCP server ready with ${this.toolRegistry.getToolCount()} tools`,
    );
  }

  async loadAllTools(): Promise<void> {
    const connectors = await this.prisma.connector.findMany({
      where: { isActive: true },
      include: { tools: { where: { isEnabled: true } } },
    });

    for (const connector of connectors) {
      for (const tool of connector.tools) {
        const toolDef = {
          id: tool.id,
          connectorId: connector.id,
          organizationId: connector.organizationId,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
          connectorType: connector.type,
          useProxy: tool.useProxy,
          connectorConfig: {
            baseUrl: connector.baseUrl,
            authType: connector.authType,
            authConfig: this.decryptAuthConfig(connector.authConfig),
            headers: connector.headers as Record<string, string> | undefined,
            envVars: connector.envVars as Record<string, string> | undefined,
            specUrl: connector.specUrl ?? undefined,
            config: connector.config as Record<string, unknown> | undefined,
          },
          endpointMapping: tool.endpointMapping as any,
          responseMapping: tool.responseMapping as
            | Record<string, unknown>
            | undefined,
        };

        // Register in our internal registry (for execution lookup)
        this.toolRegistry.registerTool(toolDef);

        // Strip params covered by env vars so the AI doesn't need to provide them
        const envVars = connector.envVars as Record<string, string> | undefined;
        const effectiveSchema = this.stripEnvVarParams(
          tool.parameters as Record<string, unknown>,
          envVars,
        );

        // Register as a native MCP tool so it appears directly in tools/list,
        // but only the first time we see this name. The upstream library's
        // McpRegistryService is single-tenant (one tool per name); our
        // ToolRegistry resolves cross-org collisions at handler-dispatch
        // time via getToolForOrg/getTool, so the second+ registration with
        // the same name would just overwrite and emit a warning.
        if (this.toolRegistry.countByName(tool.name) === 1) {
          this.registerMcpTool(tool.name, tool.description, effectiveSchema);
        }
      }
    }
  }

  async reloadConnectorTools(connectorId: string): Promise<void> {
    // Remove old tools from both registries
    const oldTools = this.toolRegistry
      .getAllTools()
      .filter((t) => t.connectorId === connectorId);
    this.toolRegistry.unregisterConnectorTools(connectorId);
    for (const tool of oldTools) {
      // Only drop from the upstream MCP registry if no other connector
      // (in any org) still exposes this tool name — otherwise we'd
      // tear down a name that another tenant still needs.
      if (this.toolRegistry.countByName(tool.name) === 0) {
        this.mcpRegistry.removeTool(tool.name);
      }
    }

    // Load and register new tools
    const connector = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      include: { tools: { where: { isEnabled: true } } },
    });

    if (connector && connector.isActive) {
      for (const tool of connector.tools) {
        const toolDef = {
          id: tool.id,
          connectorId: connector.id,
          organizationId: connector.organizationId,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
          connectorType: connector.type,
          useProxy: tool.useProxy,
          connectorConfig: {
            baseUrl: connector.baseUrl,
            authType: connector.authType,
            authConfig: this.decryptAuthConfig(connector.authConfig),
            headers: connector.headers as Record<string, string> | undefined,
            envVars: connector.envVars as Record<string, string> | undefined,
            specUrl: connector.specUrl ?? undefined,
            config: connector.config as Record<string, unknown> | undefined,
          },
          endpointMapping: tool.endpointMapping as any,
          responseMapping: tool.responseMapping as
            | Record<string, unknown>
            | undefined,
        };

        this.toolRegistry.registerTool(toolDef);

        const envVars = connector.envVars as Record<string, string> | undefined;
        const effectiveSchema = this.stripEnvVarParams(
          tool.parameters as Record<string, unknown>,
          envVars,
        );
        // Same dedup rule as loadAllTools — register on the upstream
        // single-tenant MCP registry only when this is the first tool
        // with this name across all orgs/connectors.
        if (this.toolRegistry.countByName(tool.name) === 1) {
          this.registerMcpTool(tool.name, tool.description, effectiveSchema);
        }
      }
    }

    this.logger.log(
      `Reloaded tools for connector ${connectorId}. Total tools: ${this.toolRegistry.getToolCount()}`,
    );
  }

  /**
   * Register a tool directly with the MCP library's registry so it
   * appears as a native tool in tools/list (not behind invoke_tool).
   *
   * The handler checks role-based access: if the requesting user has a
   * custom MCP role, only tools assigned to that role are executable.
   * ADMIN users and users without a custom role have unrestricted access.
   */
  private registerMcpTool(
    name: string,
    description: string,
    jsonSchema: Record<string, unknown>,
  ): void {
    const zodParams = this.jsonSchemaToZod(jsonSchema);

    this.mcpRegistry.registerTool({
      name,
      description,
      parameters: zodParams,
      handler: async (args: Record<string, unknown>, _context: any, request: any) => {
        // Check role-based tool access if user is identified
        const user = request?.user;
        if (user?.sub) {
          const allowedToolIds = await this.rolesService.getAllowedToolIds(user.sub);
          if (allowedToolIds !== null) {
            // User has restricted access — check if this tool is allowed.
            // Resolve by org first so we don't read the wrong org's tool
            // when two orgs registered the same tool name.
            const tool = user.organizationId
              ? this.toolRegistry.getToolForOrg(name, user.organizationId)
              : this.toolRegistry.getTool(name);
            if (tool && !allowedToolIds.includes(tool.id)) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Access denied: you do not have permission to use '${name}'.` }) }],
                isError: true,
              };
            }
          }

          // Check MCP server scoping — if the API key is tied to a server,
          // only allow tools from connectors assigned to that server
          if (user.mcpServerId) {
            const allowedConnectorIds = await this.mcpServersService.getConnectorIds(user.mcpServerId);
            const tool = this.toolRegistry.getTool(name, allowedConnectorIds);
            if (tool) {
              if (!allowedConnectorIds.includes(tool.connectorId)) {
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({ error: `Tool '${name}' is not available on this MCP server.` }) }],
                  isError: true,
                };
              }
            }
          } else if (user.organizationId) {
            // Authenticated user without MCP-server scoping: the global
            // /mcp endpoint must still refuse to invoke a same-named tool
            // from a different organization. Reject if no tool exists for
            // this org (an unscoped lookup would otherwise silently fall
            // back to whichever org registered the name first).
            const orgTool = this.toolRegistry.getToolForOrg(
              name,
              user.organizationId,
            );
            if (!orgTool) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      error: `Tool '${name}' is not available for your organization.`,
                    }),
                  },
                ],
                isError: true,
              };
            }
          }
        }

        // OAuth JWTs store email inside user_data, app JWTs have it top-level
        const invocationContext = {
          userId: user?.sub,
          userEmail: user?.email || user?.user_data?.email,
          organizationId: user?.organizationId,
          authMethod: user?.authMethod || 'none',
          apiKeyName: user?.apiKeyName,
          mcpServerId: user?.mcpServerId,
        };

        return this.toolExecutor.executeTool(name, args, invocationContext);
      },
    });
  }

  /**
   * Decrypt authConfig from the database (encrypted with AES-256-GCM)
   * back to a JSON string that can be parsed later by the tool executor.
   */
  private decryptAuthConfig(
    encryptedAuthConfig: string | null,
  ): string | undefined {
    if (!encryptedAuthConfig) return undefined;
    try {
      return decrypt(encryptedAuthConfig, this.encryptionKey);
    } catch (error: any) {
      this.logger.error(`Failed to decrypt authConfig: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Remove parameters from the JSON Schema that are covered by connector
   * env vars. This hides them from the AI so it doesn't need to provide them.
   */
  private stripEnvVarParams(
    schema: Record<string, unknown>,
    envVars?: Record<string, string>,
  ): Record<string, unknown> {
    if (!envVars || Object.keys(envVars).length === 0) return schema;

    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties) return schema;

    const envKeys = new Set(Object.keys(envVars));
    const newProperties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!envKeys.has(key)) {
        newProperties[key] = value;
      }
    }

    const required = (schema.required as string[]) || [];
    const newRequired = required.filter((k) => !envKeys.has(k));

    return {
      ...schema,
      properties: newProperties,
      ...(newRequired.length > 0 ? { required: newRequired } : {}),
    };
  }

  /**
   * Convert a JSON Schema object to a Zod schema for the MCP library.
   *
   * Numeric / boolean / date fields use `z.coerce.*` rather than `z.number()`
   * etc. Several MCP clients (and AI tool-call layers in general) serialize
   * every argument as a string before transport, so a tool with a numeric
   * parameter would otherwise reject perfectly valid calls like
   * `{ "top_k": "5" }` with "expected number, received string". Coercion
   * still rejects non-numeric strings (e.g. `"abc"`), so we keep the
   * validation signal where it matters.
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): any {
    const properties = schema?.properties as Record<string, any> | undefined;
    if (!properties) return z.object({});

    const required = (schema?.required as string[]) || [];
    const shape: Record<string, z.ZodType> = {};

    for (const [key, prop] of Object.entries(properties)) {
      let zodType: z.ZodType;

      switch (prop.type) {
        case 'string':
          if (prop.enum) {
            zodType = z.enum(prop.enum as [string, ...string[]]);
          } else if (prop.format === 'date-time' || prop.format === 'date') {
            // Accept ISO date strings and Date-coercible inputs.
            zodType = z.coerce.date();
          } else {
            zodType = z.string();
          }
          break;
        case 'integer':
          // .int() rejects floats; coerce handles string→number first.
          zodType = z.coerce.number().int();
          break;
        case 'number':
          zodType = z.coerce.number();
          break;
        case 'boolean':
          zodType = z.coerce.boolean();
          break;
        case 'array':
          zodType = z.array(z.any());
          break;
        case 'object':
          zodType = z.record(z.string(), z.any());
          break;
        default:
          zodType = z.any();
      }

      if (prop.description) {
        zodType = zodType.describe(prop.description);
      }

      if (prop.default !== undefined) {
        zodType = zodType.default(prop.default);
      }

      if (!required.includes(key)) {
        zodType = zodType.optional();
      }

      shape[key] = zodType;
    }

    return z.object(shape);
  }
}
