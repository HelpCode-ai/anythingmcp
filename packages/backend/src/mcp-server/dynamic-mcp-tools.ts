import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { AxiosError } from 'axios';
import { ToolRegistry } from './tool-registry';
import { RestEngine } from '../connectors/engines/rest.engine';
import { GraphqlEngine } from '../connectors/engines/graphql.engine';
import { SoapEngine } from '../connectors/engines/soap.engine';
import { McpClientEngine } from '../connectors/engines/mcp-client.engine';
import { DatabaseEngine } from '../connectors/engines/database.engine';
import { AuditService } from '../audit/audit.service';
import { RedisService } from '../common/redis.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { DeploymentService } from '../common/deployment.service';
import { PrismaService } from '../common/prisma.service';
import { interpolateConnectorConfig } from '../common/env-interpolation.util';
import { resolveInternalDbRestUrl } from '../common/db-rest.util';
import { KgService } from '../knowledge-graph/kg.service';
import type { RegisteredTool } from './tool-registry';

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
    private readonly licenseGuard: LicenseGuardService,
    private readonly deployment: DeploymentService,
    private readonly prisma: PrismaService,
    private readonly restEngine: RestEngine,
    private readonly graphqlEngine: GraphqlEngine,
    private readonly soapEngine: SoapEngine,
    private readonly mcpClientEngine: McpClientEngine,
    private readonly databaseEngine: DatabaseEngine,
    private readonly kgService: KgService,
  ) {}

  /**
   * Decide whether this tool call should be routed through the
   * proxy / web-unblocker, and return the proxy URL when it should.
   *
   * Rules:
   *  - No CONNECTOR_PROXY_URL env  → never proxy (request goes direct,
   *    even if the tool opted in — graceful degradation).
   *  - Tool must opt in (mcp_tools.use_proxy = true).
   *  - Cloud only: the workspace must be under its hourly proxy cap.
   *    The license/trial gate is already enforced at the top of
   *    executeTool (checkLicenseActive throws), so reaching here in
   *    cloud means the workspace is licensed/trialing.
   *  - Over the cap → throw (choice B: explicit error to the caller).
   *
   * Self-hosted installs get no rate limit and no license gate.
   */
  private async resolveProxy(
    tool: RegisteredTool,
    organizationId?: string,
  ): Promise<string | null> {
    const proxyUrl = process.env.CONNECTOR_PROXY_URL;
    if (!proxyUrl) return null; // env absent → direct request
    if (tool.useProxy !== true) return null; // tool didn't opt in

    if (this.deployment.isCloud() && organizationId) {
      const limit = await this.getProxyLimit(organizationId);
      const key = `proxy_rl:${organizationId}`;
      const count = await this.redisService.incr(key);
      if (count === 1) {
        await this.redisService.expire(key, 3600);
      }
      if (count > limit) {
        const ttl = await this.redisService.ttl(key);
        const mins = ttl > 0 ? Math.ceil(ttl / 60) : 60;
        throw new Error(
          `Proxy quota exceeded: this workspace is limited to ${limit} ` +
            `proxy/unblocker tool calls per hour. Try again in ~${mins} minute(s), ` +
            `or run this tool without the proxy.`,
        );
      }
    }

    return proxyUrl;
  }

  /**
   * Cloud-only db-rest host swap — see resolveInternalDbRestUrl. Kept as a thin
   * method so the host swap stays consistent with the connector "Test
   * connection" path, which uses the same shared util.
   */
  private resolveInternalBaseUrl(baseUrl: string): string {
    return resolveInternalDbRestUrl(baseUrl);
  }

  /**
   * Effective hourly proxy cap for a workspace:
   * organizations.proxy_rate_limit (DB, admin-only) ?? PROXY_RATE_LIMIT_DEFAULT
   * env ?? 100. There is intentionally no API to change the per-workspace
   * value — only a service admin via the database.
   */
  private async getProxyLimit(organizationId: string): Promise<number> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { proxyRateLimit: true },
    });
    if (org?.proxyRateLimit != null && org.proxyRateLimit >= 0) {
      return org.proxyRateLimit;
    }
    const envDefault = parseInt(process.env.PROXY_RATE_LIMIT_DEFAULT || '', 10);
    return Number.isFinite(envDefault) && envDefault >= 0 ? envDefault : 100;
  }

  /**
   * Execute a tool by name with the given parameters.
   * Handles caching, audit logging, env interpolation, and engine dispatch.
   */
  async executeTool(
    toolName: string,
    params: Record<string, unknown>,
    context?: {
      userId?: string;
      userEmail?: string;
      organizationId?: string;
      authMethod?: string;
      apiKeyName?: string;
      mcpServerId?: string;
      mcpServerName?: string;
      connectorIds?: string[];
      intent?: string;
    },
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    // Check license before executing tool (cloud mode only)
    try {
      await this.licenseGuard.checkLicenseActive(context?.organizationId);
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: err.message || 'Your license has expired. Please purchase a license at anythingmcp.com/pricing',
            }),
          },
        ],
        isError: true,
      };
    }

    // Resolve the tool with the most specific scope available so cross-org
    // collisions on the global /mcp endpoint don't leak. connectorIds is set
    // when invoked through /mcp/:serverId; organizationId is set whenever
    // we have a JWT.
    let tool = this.toolRegistry.getTool(toolName, context?.connectorIds);
    if (!tool && context?.organizationId) {
      tool = this.toolRegistry.getToolForOrg(toolName, context.organizationId);
    }
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
    const responseMapping = tool.responseMapping as
      | import('../connectors/engines/engine-types').ResponseMapping
      | undefined;
    const cacheTtl = responseMapping?.cacheTtl;
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
    let usedProxy = false;

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

      // Decide proxy routing (env present + tool opted in + cloud rate-limit).
      // Throws on over-quota (choice B). Returns null → direct request.
      const proxyUrl = await this.resolveProxy(tool, context?.organizationId);
      usedProxy = proxyUrl != null;

      const engineConfig = {
        baseUrl: this.resolveInternalBaseUrl(interpolatedConfig.baseUrl),
        authType: tool.connectorConfig.authType,
        authConfig: tool.connectorConfig.authConfig
          ? JSON.parse(tool.connectorConfig.authConfig)
          : undefined,
        headers: interpolatedConfig.headers,
        specUrl: (tool.connectorConfig as any).specUrl,
        ...(proxyUrl ? { proxyUrl } : {}),
      };

      // Inject env vars as parameter defaults (env var values fill in params
      // that match by name, so they don't need to be provided by the caller)
      const paramsWithEnv = this.injectEnvVars(params, envVars);

      // Apply JSON Schema defaults for missing params
      const mergedParams = this.applyDefaults(tool.parameters, paramsWithEnv);

      const result = await this.executeWithEngine(
        tool.connectorType,
        engineConfig,
        interpolatedMapping,
        mergedParams,
        { connectorConfig: tool.connectorConfig.config },
      );

      const durationMs = Date.now() - startTime;

      await this.auditService.logInvocation({
        toolId: tool.id,
        userId: context?.userId,
        userEmail: context?.userEmail,
        mcpServerId: context?.mcpServerId,
        organizationId: context?.organizationId,
        connectorId: tool.connectorId,
        usedProxy,
        intent: context?.intent,
        input: params,
        output: result as Record<string, unknown>,
        status: 'SUCCESS',
        durationMs,
        clientInfo: context ? JSON.stringify({
          authMethod: context.authMethod,
          apiKeyName: context.apiKeyName,
          userEmail: context.userEmail,
          mcpServerName: context.mcpServerName,
        }) : undefined,
      });

      // Grow the knowledge graph from this real call (debounced, fire-and-forget).
      void this.kgService.scheduleObservationalIngest(context?.organizationId);

      let resultText = JSON.stringify(result, null, 2);

      // Optional per-tool workflow hint. When a tool's responseMapping.followUp
      // is set, append it to the result so the calling agent sees — mid-workflow,
      // inside the tool output it just received — what it should do next (e.g.
      // "a complete answer also needs tools X and Y; call them before replying").
      // This drives multi-step tool chains far more reliably than a pre-call
      // description, which agents often read but don't act on. Purely additive
      // and opt-in: tools without followUp are unaffected.
      if (responseMapping?.followUp) {
        resultText += `\n\n---\nWORKFLOW HINT (guidance for the assistant, not part of the API response): ${responseMapping.followUp}`;
      }

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
        userId: context?.userId,
        userEmail: context?.userEmail,
        mcpServerId: context?.mcpServerId,
        organizationId: context?.organizationId,
        connectorId: tool.connectorId,
        usedProxy,
        intent: context?.intent,
        input: params,
        status: 'ERROR',
        durationMs,
        error: this.formatStoredError(errorDetail),
        clientInfo: context ? JSON.stringify({
          authMethod: context.authMethod,
          apiKeyName: context.apiKeyName,
          userEmail: context.userEmail,
          mcpServerName: context.mcpServerName,
        }) : undefined,
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

  /**
   * Inject connector env vars into params. If an env var key matches a
   * parameter name and the caller didn't provide a value, use the env var.
   */
  private injectEnvVars(
    params: Record<string, unknown>,
    envVars: Record<string, string>,
  ): Record<string, unknown> {
    if (!envVars || Object.keys(envVars).length === 0) return params;

    const result = { ...params };
    for (const [key, value] of Object.entries(envVars)) {
      if (result[key] === undefined) {
        result[key] = value;
      }
    }
    return result;
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
   * Build the string persisted in the tool_invocations.error column. Beyond the
   * HTTP status line, it folds in the upstream API response body — that body
   * carries the actual cause (e.g. weclapp "unknown property: customerName",
   * Odds API "Missing eventId", Graph API "code 190 invalid token") which the
   * bare axios message ("Request failed with status code 400") hides. Keeping it
   * in the audit log makes failures diagnosable without re-running the call.
   */
  private formatStoredError(detail: Record<string, unknown>): string {
    const parts: string[] = [];
    const head = detail.status
      ? `${detail.status} ${detail.statusText || ''}`.trim()
      : '';
    if (head) parts.push(head);
    if (detail.error) parts.push(String(detail.error));

    if (detail.responseBody !== undefined && detail.responseBody !== null) {
      let body =
        typeof detail.responseBody === 'string'
          ? detail.responseBody
          : JSON.stringify(detail.responseBody);
      if (body.length > 600) body = `${body.slice(0, 600)}…`;
      if (body && body !== '{}' && body !== '""' && body !== '[]') {
        parts.push(`body=${body}`);
      }
    }

    return parts.length > 0 ? parts.join(': ') : String(detail.error ?? 'Unknown error');
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

    // SOAP errors enriched by SoapEngine
    if (error.soapDetail) {
      return error.soapDetail as Record<string, unknown>;
    }

    // Generic errors (database, etc.)
    const detail: Record<string, unknown> = { error: error.message };
    if (error.code) detail.code = error.code;
    return detail;
  }

  private async executeWithEngine(
    connectorType: string,
    config: any,
    endpointMapping: any,
    params: Record<string, unknown>,
    extra?: { connectorConfig?: Record<string, unknown> },
  ): Promise<unknown> {
    // Static response tools — return text immediately without engine dispatch
    if (endpointMapping.method === 'static' && endpointMapping.staticResponse) {
      return { text: endpointMapping.staticResponse };
    }

    switch (connectorType) {
      case 'REST':
        return this.restEngine.execute(config, endpointMapping, params);
      case 'GRAPHQL':
        return this.graphqlEngine.execute(config, endpointMapping, params);
      case 'SOAP':
        return this.soapEngine.execute(config, endpointMapping, params);
      case 'MCP':
        return this.mcpClientEngine.execute(config, endpointMapping, params);
      case 'DATABASE': {
        const readOnly = (extra?.connectorConfig as any)?.readOnly !== false;
        return this.databaseEngine.execute(config, endpointMapping, params, { readOnly });
      }
      default:
        throw new Error(`Unsupported connector type: ${connectorType}`);
    }
  }
}
