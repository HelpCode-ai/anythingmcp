import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuth2TokenService } from './oauth2-token.service';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { DEFAULT_MCP_PATH, resolveMcpEndpointUrl } from '../../common/url.util';

@Injectable()
export class McpClientEngine {
  private readonly logger = new Logger(McpClientEngine.name);

  /**
   * Base URLs already reported by {@link warnLegacyUrlChange}, so an upgrade
   * notice is logged once per connector instead of on every tool call.
   */
  private readonly legacyUrlWarned = new Set<string>();

  constructor(private readonly oauth2TokenService: OAuth2TokenService) {}

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
      connectorId?: string;
    },
    endpointMapping: {
      method: string; // MCP tool name on remote server
      path: string; // remote MCP endpoint path
    },
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.logger.debug(
      `MCP bridge call: ${endpointMapping.method} → ${config.baseUrl}`,
    );

    const mcpUrl = resolveMcpEndpointUrl(config.baseUrl, endpointMapping.path);
    this.warnLegacyUrlChange(config.baseUrl, endpointMapping.path, mcpUrl);
    await assertSafeOutboundUrl(mcpUrl.toString());

    const headers: Record<string, string> = { ...config.headers };
    await this.injectAuth(headers, config.authType, config.authConfig, config.connectorId);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers },
    });

    const client = new Client({
      name: 'anythingmcp-bridge',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);

      const result = await client.callTool({
        name: endpointMapping.method,
        arguments: params,
      });

      return result;
    } catch (error: any) {
      // OAuth2 safety-net: retry once on auth error
      if (
        config.authType === 'OAUTH2' &&
        config.authConfig?.refreshToken &&
        config.authConfig?.tokenUrl &&
        error?.message?.includes?.('401')
      ) {
        this.logger.debug('MCP OAuth2: 401 despite proactive refresh, retrying...');
        const newToken = await this.oauth2TokenService.refreshToken(
          config.authConfig,
          config.connectorId,
        );
        if (newToken) {
          const retryHeaders: Record<string, string> = { ...config.headers };
          retryHeaders['Authorization'] = `Bearer ${newToken}`;

          const retryTransport = new StreamableHTTPClientTransport(mcpUrl, {
            requestInit: { headers: retryHeaders },
          });
          const retryClient = new Client({
            name: 'anythingmcp-bridge',
            version: '1.0.0',
          });
          try {
            await retryClient.connect(retryTransport);
            return await retryClient.callTool({
              name: endpointMapping.method,
              arguments: params,
            });
          } finally {
            try { await retryClient.close(); } catch { /* ignore */ }
          }
        }
      }
      throw error;
    } finally {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Discover available tools on a remote MCP server.
   */
  async listTools(config: {
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    mcpPath?: string;
    connectorId?: string;
  }): Promise<
    Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    }>
  > {
    const mcpUrl = resolveMcpEndpointUrl(config.baseUrl, config.mcpPath);
    this.warnLegacyUrlChange(config.baseUrl, config.mcpPath, mcpUrl);

    this.logger.debug(`MCP listTools: ${mcpUrl.toString()}`);

    // Discovery reaches a user-supplied URL just like execute() does, so it
    // needs the same SSRF guard — it was missing here.
    await assertSafeOutboundUrl(mcpUrl.toString());

    const headers: Record<string, string> = { ...config.headers };
    await this.injectAuth(headers, config.authType, config.authConfig, config.connectorId);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers },
    });

    const client = new Client({
      name: 'anythingmcp-bridge',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);
      const result = await client.listTools();

      return (result.tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: (tool.inputSchema as Record<string, unknown>) || {
          type: 'object',
          properties: {},
        },
        ...(tool.outputSchema
          ? { outputSchema: tool.outputSchema as Record<string, unknown> }
          : {}),
        // The upstream server knows its own tools' semantics better than any
        // heuristic of ours, so carry its annotations through verbatim.
        ...(tool.annotations
          ? { annotations: tool.annotations as Record<string, unknown> }
          : {}),
      }));
    } finally {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  /**
   * Until issue #501 was fixed, every bridge request went to `<origin>/mcp`
   * because the path was resolved root-absolutely against the base URL. Any
   * connector whose base URL carried a path is therefore called at a different
   * address after the upgrade — log that once per connector so a self-hosted
   * operator can see exactly what moved instead of guessing.
   */
  private warnLegacyUrlChange(
    baseUrl: string,
    pathOverride: string | undefined,
    resolved: URL,
  ): void {
    if (this.legacyUrlWarned.has(baseUrl)) return;

    let legacy: string;
    try {
      legacy = new URL(pathOverride || DEFAULT_MCP_PATH, baseUrl).toString();
    } catch {
      return;
    }
    if (legacy === resolved.toString()) return;

    this.legacyUrlWarned.add(baseUrl);
    this.logger.warn(
      `MCP endpoint for "${baseUrl}" now resolves to ${resolved.toString()} ` +
        `(previous releases called it at ${legacy}) — the base URL's path is ` +
        `no longer discarded.`,
    );
  }

  private async injectAuth(
    headers: Record<string, string>,
    authType: string,
    authConfig?: Record<string, unknown>,
    connectorId?: string,
  ): Promise<void> {
    if (!authConfig) return;

    switch (authType) {
      case 'BEARER_TOKEN':
        headers['Authorization'] = `Bearer ${authConfig.token}`;
        break;
      case 'API_KEY':
        headers[String(authConfig.headerName || 'X-API-Key')] = String(
          authConfig.apiKey,
        );
        break;
      case 'OAUTH2': {
        const accessToken = await this.oauth2TokenService.getAccessToken(
          authConfig,
          connectorId,
        );
        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`;
        }
        break;
      }
    }
  }
}
