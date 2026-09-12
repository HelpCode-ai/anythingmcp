import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { McpStrategy, MCP_STRATEGY } from '@rekog/mcp-nest';
import type { Connector, McpTool } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma.service';
import { decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { ToolRegistry } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { RolesService } from '../roles/roles.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpSessionManager } from '../mcp-servers/mcp-session.manager';
import { KgStaticService } from '../knowledge-graph/kg-static.service';
import {
  ToolAnnotations,
  deriveToolAnnotations,
} from './tool-annotations';

/**
 * The synthetic role that makes one tool visible in the GLOBAL `/mcp`
 * `tools/list`. Prefixed so it can never collide with a real role name.
 */
export function toolVisibilityRole(toolName: string): string {
  return `tool:${toolName}`;
}

@Injectable()
export class McpServerService implements OnModuleInit {
  private readonly logger = new Logger(McpServerService.name);
  private mcpRegistry!: McpStrategy;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: DynamicMcpTools,
    private readonly moduleRef: ModuleRef,
    private readonly configService: ConfigService,
    private readonly rolesService: RolesService,
    private readonly mcpServersService: McpServersService,
    private readonly kgStatic: KgStaticService,
    private readonly sessionManager: McpSessionManager,
  ) {
    this.encryptionKey = getRequiredSecret(
      'ENCRYPTION_KEY',
      this.configService.get<string>('ENCRYPTION_KEY'),
    );
  }

  async onModuleInit() {
    // Resolve the MCP strategy from the global app context. In mcp-nest v2
    // the strategy IS the registry: `McpRegistryService` no longer exists, and
    // the strategy instance provided under MCP_STRATEGY owns tool
    // registration. `registerTool` and `removeTool` kept the same shape, so
    // only the lookup changed.
    this.mcpRegistry = this.moduleRef.get<McpStrategy>(MCP_STRATEGY, {
      strict: false,
    });

    this.logger.log('Initializing dynamic MCP server...');
    await this.loadAllTools();
    this.logger.log(
      `MCP server ready with ${this.toolRegistry.getToolCount()} tools`,
    );
  }

  /**
   * How many connectors to pull from the database at a time in
   * {@link loadAllTools}. Small enough that the raw Prisma rows for a page are
   * garbage in between pages; large enough that a full boot is a few dozen
   * round trips, not hundreds.
   */
  private static readonly LOAD_PAGE_SIZE = 25;

  /**
   * Register every enabled tool of every active connector, across all tenants.
   *
   * Read in pages rather than as one `findMany`. The registry itself is
   * unavoidably large — on the cloud instance it holds ~22k tools, ~118 MB of
   * raw JSON before V8 object overhead — but loading every connector in a
   * single query ALSO materialised the whole result set at once, so peak heap
   * at boot was roughly twice the steady state. That is what pushed the
   * process past --max-old-space-size and crash-looped it nine times on
   * 10 Sep. Paging keeps the transient half bounded to one page.
   */
  async loadAllTools(): Promise<void> {
    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.connector.findMany({
        where: { isActive: true },
        include: { tools: { where: { isEnabled: true } } },
        orderBy: { id: 'asc' },
        take: McpServerService.LOAD_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (page.length === 0) break;

      for (const connector of page) {
        this.registerConnectorTools(connector);
      }

      cursor = page[page.length - 1].id;
      if (page.length < McpServerService.LOAD_PAGE_SIZE) break;
    }
  }

  /**
   * Register one connector's enabled tools in both registries. Shared by the
   * boot-time load and by {@link reloadConnectorTools} so the two can't drift.
   */
  private registerConnectorTools(
    connector: Connector & { tools: McpTool[] },
  ): void {
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
        outputSchema: tool.outputSchema as unknown,
        annotations: tool.annotations as unknown,
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
        this.registerMcpTool(
          tool.name,
          tool.description,
          effectiveSchema,
          deriveToolAnnotations(toolDef),
        );
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
      this.registerConnectorTools(connector);
    }

    this.logger.log(
      `Reloaded tools for connector ${connectorId}. Total tools: ${this.toolRegistry.getToolCount()}`,
    );

    // Keep the knowledge-graph static layer in sync with this connector's tool
    // surface. Fire-and-forget: it must never block or fail the tool reload.
    if (connector?.organizationId) {
      this.kgStatic
        .syncConnector(connectorId)
        .catch((e) =>
          this.logger.warn(`KG static sync failed for ${connectorId}: ${e.message}`),
        );
    }

    // Push tools/list_changed to any live stateful MCP sessions whose surface
    // this affects. Fire-and-forget: must never block or fail a tool reload.
    this.sessionManager
      .notifyToolsChanged()
      .catch((e) =>
        this.logger.warn(`MCP session notify failed: ${e.message}`),
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
    annotations?: ToolAnnotations,
  ): void {
    const zodParams = this.jsonSchemaToZod(jsonSchema);

    this.mcpRegistry.registerTool({
      name,
      description,
      parameters: zodParams,
      // Gate this entry on a synthetic "role" naming the tool itself, matched
      // with 'any'. The transport's `tools/list` handler is SYNCHRONOUS, so it
      // cannot ask the database who the caller is — but it does compare
      // `user.roles` against this list. The global endpoint therefore resolves
      // the caller's visible tools asynchronously BEFORE delegating and plants
      // the answer on `req.user.roles`. See `visibleToolRoles` in
      // mcp-endpoint.controller.ts.
      //
      // Keyed on NAME, not tool id: this registry holds one entry per name
      // across every organization, so the id belongs to whichever tenant
      // registered it first. Name is also what the call handler resolves by
      // (`getToolForOrg(name, org)`), so the two stay consistent.
      requiredRoles: [toolVisibilityRole(name)],
      requiredRolesMatch: 'any',
      ...(annotations ? { annotations } : {}),
      handler: async (args: Record<string, unknown>, _context: any, request: any) => {
        // Role check, kept as the SECOND layer. The transport now refuses a
        // disallowed call before the handler runs, because `requiredRoles`
        // above gates `tools/call` as well as `tools/list`. This stays so that
        // a tool registered without a visibility role — a future code path, a
        // merge that drops the option — is still not freely callable. Defence
        // in depth, not the only gate.
        const user = request?.user;
        // Set when the caller's credential is pinned to one MCP server, so the
        // executor resolves the tool in that server's scope rather than the
        // whole organization's.
        let serverConnectorIds: string[] | undefined;
        if (user?.sub) {
          // Global /mcp registry: there is no server-scoped org here, so the
          // caller's active org is the relevant one — same org used by
          // getToolForOrg below.
          const allowedToolIds = await this.rolesService.getAllowedToolIds(
            user.sub,
            user.organizationId,
          );
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
          // only allow tools from connectors assigned to that server.
          //
          // The refusal used to sit inside `if (tool)`, so a name that matched
          // NO connector on this server fell straight through the guard and was
          // then resolved in a wider scope by the executor. Refuse on the
          // absence, which is the case that mattered.
          if (user.mcpServerId) {
            serverConnectorIds = await this.mcpServersService.getConnectorIds(
              user.mcpServerId,
            );
            const tool = this.toolRegistry.getTool(name, serverConnectorIds);
            if (!tool) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Tool '${name}' is not available on this MCP server.` }) }],
                isError: true,
              };
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
          connectorIds: serverConnectorIds,
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
          } else {
            // A date stays a STRING. This used to be `z.coerce.date()`, which
            // produces a ZodDate — and the global /mcp advertises its tools by
            // serialising these zod schemas back to JSON Schema, where a Date
            // has no representation. The serialiser threw, so `tools/list`
            // failed for the WHOLE workspace with
            // `-32603 Date cannot be represented in JSON Schema`, not just for
            // the offending tool: 91 tools across 9 workspaces on the cloud
            // instance, which could not use the shared endpoint at all.
            //
            // Nothing is lost. The value is on its way into a query string or a
            // request body, so it has to end up as text regardless, and
            // `format` is documentation for the caller either way. The
            // per-server endpoint has always mapped strings this way
            // (`jsonSchemaToZodShape`); the two paths now agree.
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
