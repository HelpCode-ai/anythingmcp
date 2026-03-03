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
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpCombinedAuthGuard } from '../auth/mcp-combined-auth.guard';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { ToolRegistry } from './tool-registry';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import { RolesService } from '../roles/roles.service';

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

    // 2. Get connector IDs assigned to this server
    const connectorIds = await this.mcpServersService.getConnectorIds(serverId);

    // 3. Filter tools to only those from assigned connectors
    const allTools = this.toolRegistry.getAllTools();
    const serverTools = allTools.filter((t) => connectorIds.includes(t.connectorId));

    // 4. Further filter by role-based access if user is identified
    const user = (req as any).user;
    let allowedToolIds: string[] | null = null;
    if (user?.sub) {
      allowedToolIds = await this.rolesService.getAllowedToolIds(user.sub);
    }

    // 5. Create a per-request MCP server with only the assigned tools
    const mcpServer = new McpServer(
      { name: mcpServerConfig.name, version: mcpServerConfig.version || '1.0.0' },
    );

    for (const tool of serverTools) {
      // Skip tools not allowed by role
      if (allowedToolIds !== null && !allowedToolIds.includes(tool.id)) {
        continue;
      }

      const schema = this.stripEnvVarParams(tool.parameters, tool.connectorConfig.envVars);
      const zodShape = this.jsonSchemaToZodShape(schema);

      mcpServer.tool(tool.name, tool.description, zodShape, async (args: any) => {
        const result = await this.toolExecutor.executeTool(tool.name, args);
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
