import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuth2TokenService } from './oauth2-token.service';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';

@Injectable()
export class McpClientEngine {
  private readonly logger = new Logger(McpClientEngine.name);

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

    const mcpUrl = new URL(
      endpointMapping.path || '/mcp',
      config.baseUrl,
    );
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
    }>
  > {
    const mcpUrl = new URL(config.mcpPath || '/mcp', config.baseUrl);

    this.logger.debug(`MCP listTools: ${mcpUrl.toString()}`);

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
      }));
    } finally {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
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
