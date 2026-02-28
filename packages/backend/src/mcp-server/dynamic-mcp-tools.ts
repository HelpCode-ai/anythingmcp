import { Injectable, Logger } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { createHash } from 'crypto';
import { ToolRegistry } from './tool-registry';
import { RestEngine } from '../connectors/engines/rest.engine';
import { GraphqlEngine } from '../connectors/engines/graphql.engine';
import { SoapEngine } from '../connectors/engines/soap.engine';
import { McpClientEngine } from '../connectors/engines/mcp-client.engine';
import { DatabaseEngine } from '../connectors/engines/database.engine';
import { WebhookEngine } from '../connectors/engines/webhook.engine';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../common/redis.service';
import { interpolateConnectorConfig } from '../common/env-interpolation.util';

@Injectable()
export class DynamicMcpTools {
  private readonly logger = new Logger(DynamicMcpTools.name);

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly auditService: AuditService,
    private readonly redisService: RedisService,
    private readonly restEngine: RestEngine,
    private readonly graphqlEngine: GraphqlEngine,
    private readonly soapEngine: SoapEngine,
    private readonly mcpClientEngine: McpClientEngine,
    private readonly databaseEngine: DatabaseEngine,
    private readonly webhookEngine: WebhookEngine,
  ) {}

  @Tool({
    name: 'list_available_tools',
    description:
      'List all available tools on this AnythingToMCP server. ' +
      'Returns the name, description, and parameters of each configured tool. ' +
      'Use this to discover what APIs and operations are available.',
    parameters: z.object({}) as any,
  })
  async listAvailableTools() {
    const tools = this.toolRegistry.getAllTools();
    const summary = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { totalTools: summary.length, tools: summary },
            null,
            2,
          ),
        },
      ],
    };
  }

  @Tool({
    name: 'search_tools',
    description:
      'Search for tools by keyword across names and descriptions. ' +
      'Useful when there are many tools and you need to find specific functionality. ' +
      'Returns matching tools sorted by relevance.',
    parameters: z.object({
      query: z
        .string()
        .describe('Search query to match against tool names and descriptions'),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum number of results to return (default: 10)'),
    }) as any,
  })
  async searchTools(args: { query: string; limit?: number }) {
    const query = args.query.toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const tools = this.toolRegistry.getAllTools();
    const limit = args.limit || 10;

    // Score each tool by how many query words appear in name + description
    const scored = tools
      .map((t) => {
        const text = `${t.name} ${t.description}`.toLowerCase();
        let score = 0;
        for (const word of words) {
          if (t.name.toLowerCase().includes(word)) score += 3; // name match is weighted higher
          if (t.description.toLowerCase().includes(word)) score += 1;
        }
        return { tool: t, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const results = scored.map((s) => ({
      name: s.tool.name,
      description: s.tool.description,
      parameters: s.tool.parameters,
      relevanceScore: s.score,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            { query: args.query, resultCount: results.length, tools: results },
            null,
            2,
          ),
        },
      ],
    };
  }

  @Tool({
    name: 'invoke_tool',
    description:
      'Invoke a dynamically configured tool by name. ' +
      'First call list_available_tools to see what tools exist, ' +
      'then call this with the tool name and its parameters.',
    parameters: z.object({
      tool_name: z
        .string()
        .describe(
          'The name of the tool to invoke (from list_available_tools)',
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Parameters to pass to the tool (as a JSON object)'),
    }) as any,
  })
  async invokeTool(args: {
    tool_name: string;
    params?: Record<string, unknown>;
  }) {
    const tool = this.toolRegistry.getTool(args.tool_name);
    if (!tool) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Tool '${args.tool_name}' not found. Use list_available_tools to see available tools.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // Check response cache
    const cacheTtl = (tool.responseMapping as any)?.cacheTtl;
    if (cacheTtl && cacheTtl > 0) {
      const cacheKey = this.buildCacheKey(args.tool_name, args.params || {});
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        this.logger.debug(`Cache hit for tool ${args.tool_name}`);
        return {
          content: [
            { type: 'text' as const, text: cached },
          ],
        };
      }
    }

    const startTime = Date.now();

    try {
      const envVars = tool.connectorConfig.envVars || {};

      // Interpolate {{VAR}} patterns in config and endpoint mapping
      const { config: interpolatedConfig, endpointMapping: interpolatedMapping } =
        interpolateConnectorConfig(
          {
            baseUrl: tool.connectorConfig.baseUrl,
            headers: tool.connectorConfig.headers,
          },
          tool.endpointMapping,
          envVars,
        );

      const engineConfig = {
        baseUrl: interpolatedConfig.baseUrl,
        authType: tool.connectorConfig.authType,
        authConfig: tool.connectorConfig.authConfig
          ? JSON.parse(tool.connectorConfig.authConfig)
          : undefined,
        headers: interpolatedConfig.headers,
      };

      // Apply JSON Schema defaults for missing params
      const mergedParams = this.applyDefaults(tool.parameters, args.params || {});

      const result = await this.executeWithEngine(
        tool.connectorType,
        engineConfig,
        interpolatedMapping,
        mergedParams,
      );

      const durationMs = Date.now() - startTime;

      await this.auditService.logInvocation({
        toolId: tool.id,
        input: args.params || {},
        output: result as Record<string, unknown>,
        status: 'SUCCESS',
        durationMs,
      });

      const resultText = JSON.stringify(result, null, 2);

      // Cache the response if cacheTtl is set
      if (cacheTtl && cacheTtl > 0) {
        const cacheKey = this.buildCacheKey(args.tool_name, args.params || {});
        await this.redisService.set(cacheKey, resultText, cacheTtl);
        this.logger.debug(`Cached response for tool ${args.tool_name} (TTL: ${cacheTtl}s)`);
      }

      return {
        content: [
          { type: 'text' as const, text: resultText },
        ],
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      await this.auditService.logInvocation({
        toolId: tool.id,
        input: args.params || {},
        status: 'ERROR',
        durationMs,
        error: error.message,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: error.message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private buildCacheKey(toolName: string, params: Record<string, unknown>): string {
    const paramsHash = createHash('md5')
      .update(JSON.stringify(params, Object.keys(params).sort()))
      .digest('hex')
      .slice(0, 12);
    return `tool_cache:${toolName}:${paramsHash}`;
  }

  private applyDefaults(
    schema: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const properties = (schema as any)?.properties;
    if (!properties || typeof properties !== 'object') return params;

    const result = { ...params };
    for (const [key, prop] of Object.entries(properties)) {
      if (result[key] === undefined && (prop as any)?.default !== undefined) {
        result[key] = (prop as any).default;
      }
    }
    return result;
  }

  private async executeWithEngine(
    connectorType: string,
    config: any,
    endpointMapping: any,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (connectorType) {
      case 'REST':
        return this.restEngine.execute(config, endpointMapping, params);
      case 'GRAPHQL':
        return this.graphqlEngine.execute(config, endpointMapping, params);
      case 'SOAP':
        return this.soapEngine.execute(config, endpointMapping, params);
      case 'MCP':
        return this.mcpClientEngine.execute(config, endpointMapping, params);
      case 'DATABASE':
        return this.databaseEngine.execute(config, endpointMapping, params);
      case 'WEBHOOK':
        return this.webhookEngine.execute(config, endpointMapping, params);
      default:
        throw new Error(`Unsupported connector type: ${connectorType}`);
    }
  }
}
