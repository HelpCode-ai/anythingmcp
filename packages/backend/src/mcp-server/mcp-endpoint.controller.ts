import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Req,
  Res,
  Body,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpCombinedAuthGuard } from '../auth/mcp-combined-auth.guard';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { ToolRegistry } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { RolesService } from '../roles/roles.service';
import { registerDemoTools } from './mcp-demo.tools';

/**
 * Per-server MCP endpoint controller.
 *
 * Handles POST/GET/DELETE at /mcp/:serverId, creating a fresh MCP server
 * per request that only exposes tools from connectors assigned to that server.
 *
 * This solves the single-endpoint limitation of @rekog/mcp-nest by giving
 * each MCP server its own unique URL that clients like Claude Desktop
 * can connect to independently (via OAuth or API key).
 */
@Controller('mcp')
@SkipThrottle()
@UseGuards(McpCombinedAuthGuard)
export class McpEndpointController {
  private readonly logger = new Logger(McpEndpointController.name);

  constructor(
    private readonly mcpServersService: McpServersService,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolExecutor: DynamicMcpTools,
    private readonly rolesService: RolesService,
  ) {}

  // ─── Public, anonymous, static demo MCP server ──────────────────────────
  // A self-describing MCP endpoint at the EXACT path /mcp/demo. It exposes only
  // static "how to use AnythingMCP" tools and NEVER resolves a serverId, queries
  // the database, or touches connectors / tenant data — so it has nothing to
  // leak. Exists so directory crawlers (Glama, Smithery, mcp.so) and agents can
  // introspect a working MCP server without auth. The auth guard exempts ONLY
  // this exact path; every /mcp/:serverId stays fail-closed.
  //
  // MUST be declared BEFORE the ':serverId' routes so the static "demo" segment
  // wins route matching (otherwise it'd resolve as serverId="demo").
  @Post('demo')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async handleDemoPost(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    await this.handleDemoRequest(req, res, body);
  }

  @Get('demo')
  handleDemoGet(@Req() _req: Request, @Res() res: Response) {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  }

  @Post(':serverId')
  async handlePost(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    await this.handleMcpRequest(serverId, req, res, body);
  }

  @Get(':serverId')
  async handleGet(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Stateless mode: GET is not supported
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  }

  @Delete(':serverId')
  async handleDelete(
    @Param('serverId') serverId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Stateless mode: DELETE is not supported
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  }

  /**
   * Handle the public demo MCP server. Builds a per-request McpServer with only
   * the static info tools (see registerDemoTools) — no DB, no connectors, no
   * tenant resolution. Never reaches any of the per-server logic below.
   */
  private async handleDemoRequest(
    req: Request,
    res: Response,
    body: unknown,
  ) {
    const mcpServer = new McpServer(
      { name: 'AnythingMCP Demo', version: '1.0.0' },
      {
        instructions:
          'Public, read-only demo of AnythingMCP. These tools describe the ' +
          'product and how to use it; they expose no customer data. Start with ' +
          'anythingmcp_overview.',
      },
    );
    registerDemoTools(mcpServer);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error: any) {
      this.logger.error(`Error handling demo MCP request: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      try {
        await transport.close();
        await mcpServer.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private async handleMcpRequest(
    serverId: string,
    req: Request,
    res: Response,
    body: unknown,
  ) {
    // 1. Resolve the MCP server
    const mcpServerConfig = await this.mcpServersService.findById(serverId);
    if (!mcpServerConfig) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'MCP server not found' },
        id: null,
      });
    }

    if (!mcpServerConfig.isActive) {
      return res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'MCP server is inactive' },
        id: null,
      });
    }

    // Tenant isolation: a request scoped to a specific server must come from a
    // principal who is a MEMBER of that server's organization. Fail closed —
    // deny when membership can't be established. Instance-level static
    // credentials (self-host, not organization-scoped) are exempt.
    //
    // Membership is checked against organization_members, not just the user's
    // primary `organizationId` column: a user who belongs to several
    // workspaces must reach servers in any org they're a member of, while a
    // non-member is still denied. The primary-org match is kept as a
    // zero-query fast path for the common single-org case.
    const user = (req as any).user;
    const isInstanceLevel =
      user?.authMethod === 'static_api_key' ||
      user?.authMethod === 'static_bearer' ||
      user?.authMethod === 'none';
    if (!isInstanceLevel) {
      const serverOrg = mcpServerConfig.organizationId;
      const primaryOrgMatches =
        !!user?.organizationId && user.organizationId === serverOrg;
      const isMember =
        primaryOrgMatches ||
        (!!user?.sub &&
          !!serverOrg &&
          (await this.mcpServersService.isUserInOrganization(
            user.sub,
            serverOrg,
          )));
      if (!isMember) {
        return res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Access denied' },
          id: null,
        });
      }
    }

    // 2. Get connector IDs and composed instructions for this server
    const [connectorIds, instructions] = await Promise.all([
      this.mcpServersService.getConnectorIds(serverId),
      this.mcpServersService.getComposedInstructions(serverId),
    ]);

    // 3. Filter tools to only those from assigned connectors
    const allTools = this.toolRegistry.getAllTools();
    const serverTools = allTools.filter((t) => connectorIds.includes(t.connectorId));

    // 4. Further filter by role-based access if user is identified
    let allowedToolIds: string[] | null = null;
    if (user?.sub) {
      allowedToolIds = await this.rolesService.getAllowedToolIds(user.sub);
    }

    // 5. Create a per-request MCP server with only the assigned tools
    const mcpServer = new McpServer(
      { name: mcpServerConfig.name, version: mcpServerConfig.version || '1.0.0' },
      { instructions },
    );

    // Build invocation context for audit logging and tool scoping
    // OAuth JWTs store email inside user_data, app JWTs have it top-level
    const invocationContext = {
      userId: user?.sub as string | undefined,
      userEmail: (user?.email || user?.user_data?.email) as string | undefined,
      organizationId:
        (user?.organizationId as string | undefined) ||
        mcpServerConfig.organizationId,
      authMethod: (user?.authMethod || 'none') as string,
      apiKeyName: user?.apiKeyName as string | undefined,
      mcpServerId: mcpServerConfig.id,
      mcpServerName: mcpServerConfig.name,
      connectorIds,
    };

    // Dedupe by tool name. A server can have two connectors that expose the
    // same tool name (e.g. the same connector assigned twice, or two configs
    // of one provider). The MCP SDK throws "Tool X is already registered" on
    // the second registration, which previously 500'd the ENTIRE request and
    // took down every tool on the server. Register the first occurrence of
    // each name and skip the rest, so one duplicate can't break the endpoint.
    const registeredNames = new Set<string>();
    for (const tool of serverTools) {
      // Skip tools not allowed by role
      if (allowedToolIds !== null && !allowedToolIds.includes(tool.id)) {
        continue;
      }

      if (registeredNames.has(tool.name)) {
        this.logger.warn(
          `Duplicate tool name "${tool.name}" on server ${serverId} — skipping the extra copy (check for duplicate connector assignments).`,
        );
        continue;
      }
      registeredNames.add(tool.name);

      const schema = this.stripEnvVarParams(tool.parameters, tool.connectorConfig.envVars);
      const zodShape = this.jsonSchemaToZodShape(schema);

      mcpServer.tool(tool.name, tool.description, zodShape, async (args: any) => {
        const result = await this.toolExecutor.executeTool(tool.name, args, invocationContext);
        return result;
      });
    }

    // 6. Create transport and handle the request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error: any) {
      this.logger.error(`Error handling MCP request for server ${serverId}: ${error.message}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      // Clean up stateless server
      try {
        await transport.close();
        await mcpServer.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Convert a JSON Schema to a Zod raw shape for McpServer.tool() registration.
   */
  private jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
    const properties = schema?.properties as Record<string, any> | undefined;
    if (!properties) return {};

    const required = (schema?.required as string[]) || [];
    const shape: Record<string, z.ZodType> = {};

    for (const [key, prop] of Object.entries(properties)) {
      let zodType: z.ZodType;

      switch (prop.type) {
        case 'string':
          zodType = prop.enum
            ? z.enum(prop.enum as [string, ...string[]])
            : z.string();
          break;
        case 'number':
        case 'integer':
          zodType = z.number();
          break;
        case 'boolean':
          zodType = z.boolean();
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

    return shape;
  }

  /**
   * Remove parameters covered by connector env vars.
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
}
