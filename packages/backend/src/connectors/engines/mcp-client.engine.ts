import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

@Injectable()
export class McpClientEngine {
  private readonly logger = new Logger(McpClientEngine.name);

  // In-memory cache for refreshed OAuth2 tokens (keyed by tokenUrl)
  private tokenCache = new Map<
    string,
    { accessToken: string; expiresAt: number }
  >();

  async execute(
    config: {
      baseUrl: string;
      authType: string;
      authConfig?: Record<string, unknown>;
      headers?: Record<string, string>;
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

    const headers: Record<string, string> = { ...config.headers };
    this.injectAuth(headers, config.authType, config.authConfig);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers },
    });

    const client = new Client({
      name: 'anything-to-mcp-bridge',
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
      // OAuth2 auto-refresh: retry once on auth error
      if (
        config.authType === 'OAUTH2' &&
        config.authConfig?.refreshToken &&
        config.authConfig?.tokenUrl &&
        error?.message?.includes?.('401')
      ) {
        this.logger.debug('MCP OAuth2: token may be expired, attempting refresh...');
        const newToken = await this.refreshOAuth2Token(config.authConfig);
        if (newToken) {
          const retryHeaders: Record<string, string> = { ...config.headers };
          retryHeaders['Authorization'] = `Bearer ${newToken}`;

          const retryTransport = new StreamableHTTPClientTransport(mcpUrl, {
            requestInit: { headers: retryHeaders },
          });
          const retryClient = new Client({
            name: 'anything-to-mcp-bridge',
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
    this.injectAuth(headers, config.authType, config.authConfig);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers },
    });

    const client = new Client({
      name: 'anything-to-mcp-bridge',
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

  private injectAuth(
    headers: Record<string, string>,
    authType: string,
    authConfig?: Record<string, unknown>,
  ): void {
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
        let accessToken = String(authConfig.accessToken || '');

        // Check if we have a cached (refreshed) token
        const tokenUrl = String(authConfig.tokenUrl || '');
        if (tokenUrl) {
          const cached = this.tokenCache.get(tokenUrl);
          if (cached && cached.expiresAt > Date.now()) {
            accessToken = cached.accessToken;
          }
        }

        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`;
        }
        break;
      }
    }
  }

  private async refreshOAuth2Token(
    authConfig: Record<string, unknown>,
  ): Promise<string | null> {
    const tokenUrl = String(authConfig.tokenUrl);
    const refreshToken = String(authConfig.refreshToken);
    const clientId = authConfig.clientId
      ? String(authConfig.clientId)
      : undefined;
    const clientSecret = authConfig.clientSecret
      ? String(authConfig.clientSecret)
      : undefined;

    try {
      const body: Record<string, string> = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      };
      if (clientId) body.client_id = clientId;
      if (clientSecret) body.client_secret = clientSecret;

      const response = await axios.post(
        tokenUrl,
        new URLSearchParams(body).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        },
      );

      const { access_token, expires_in } = response.data;
      if (!access_token) return null;

      // Cache the new token (default 1 hour if no expires_in)
      const expiresInMs = (expires_in || 3600) * 1000;
      this.tokenCache.set(tokenUrl, {
        accessToken: access_token,
        expiresAt: Date.now() + expiresInMs - 60000, // refresh 1 min early
      });

      this.logger.debug('MCP OAuth2: token refreshed successfully');
      return access_token;
    } catch (err: any) {
      this.logger.warn(`MCP OAuth2 token refresh failed: ${err.message}`);
      return null;
    }
  }
}
