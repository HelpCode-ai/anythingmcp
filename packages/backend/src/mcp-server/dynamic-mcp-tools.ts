import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { AxiosError } from 'axios';
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

/**
 * ToolExecutor — executes dynamically registered MCP tools.
 *
 * Each tool is mapped to a connector engine (REST, GraphQL, SOAP, etc.)
 * and executed with caching, audit logging, and env interpolation.
 */
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

  /**
   * Execute a tool by name with the given parameters.
   * Handles caching, audit logging, env interpolation, and engine dispatch.
   */
  async executeTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const tool = this.toolRegistry.getTool(toolName);
    if (!tool) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Tool '${toolName}' not found.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // Check response cache
    const cacheTtl = (tool.responseMapping as any)?.cacheTtl;
    if (cacheTtl && cacheTtl > 0) {
      const cacheKey = this.buildCacheKey(toolName, params);
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        this.logger.debug(`Cache hit for tool ${toolName}`);
        return {
          content: [{ type: 'text' as const, text: cached }],
        };
      }
    }

    const startTime = Date.now();

    try {
      const envVars = tool.connectorConfig.envVars || {};

      // Interpolate {{VAR}} patterns in config and endpoint mapping
      const {
        config: interpolatedConfig,
        endpointMapping: interpolatedMapping,
      } = interpolateConnectorConfig(
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
      const mergedParams = this.applyDefaults(tool.parameters, params);

      const result = await this.executeWithEngine(
        tool.connectorType,
        engineConfig,
        interpolatedMapping,
        mergedParams,
      );

      const durationMs = Date.now() - startTime;

      await this.auditService.logInvocation({
        toolId: tool.id,
        input: params,
        output: result as Record<string, unknown>,
        status: 'SUCCESS',
        durationMs,
      });

      const resultText = JSON.stringify(result, null, 2);

      // Cache the response if cacheTtl is set
      if (cacheTtl && cacheTtl > 0) {
        const cacheKey = this.buildCacheKey(toolName, params);
        await this.redisService.set(cacheKey, resultText, cacheTtl);
        this.logger.debug(
          `Cached response for tool ${toolName} (TTL: ${cacheTtl}s)`,
        );
      }

      return {
        content: [{ type: 'text' as const, text: resultText }],
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      const errorDetail = this.extractErrorDetail(error);

      await this.auditService.logInvocation({
        toolId: tool.id,
        input: params,
        status: 'ERROR',
        durationMs,
        error: errorDetail.status
          ? `${errorDetail.status} ${errorDetail.statusText || ''}: ${errorDetail.error}`
          : String(errorDetail.error),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(errorDetail, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private buildCacheKey(
    toolName: string,
    params: Record<string, unknown>,
  ): string {
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

  /**
   * Extract rich error details from different error types so that the AI
   * client receives enough context to understand the failure and retry.
   */
  private extractErrorDetail(error: any): Record<string, unknown> {
    if (error instanceof AxiosError && error.response) {
      const res = error.response;

      // Pick only headers useful for the AI to decide on retries
      const relevantHeaders: Record<string, string> = {};
      const headerKeys = [
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'www-authenticate',
        'content-type',
      ];
      for (const key of headerKeys) {
        const value = res.headers?.[key];
        if (value) relevantHeaders[key] = String(value);
      }

      const detail: Record<string, unknown> = {
        error: error.message,
        status: res.status,
        statusText: res.statusText,
      };

      // Include the API response body (the most useful part for the AI)
      if (res.data !== undefined && res.data !== null && res.data !== '') {
        detail.responseBody = res.data;
      }

      if (Object.keys(relevantHeaders).length > 0) {
        detail.responseHeaders = relevantHeaders;
      }

      return detail;
    }

    // AxiosError without a response (network error, timeout, DNS failure)
    if (error instanceof AxiosError) {
      return {
        error: error.message,
        code: error.code, // e.g. ECONNREFUSED, ECONNABORTED, ETIMEDOUT
      };
    }

    // Generic errors (database, SOAP, etc.)
    const detail: Record<string, unknown> = { error: error.message };
    if (error.code) detail.code = error.code;
    return detail;
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
