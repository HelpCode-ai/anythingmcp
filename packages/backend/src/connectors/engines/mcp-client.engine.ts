import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

@Injectable()
export class McpClientEngine {
  private readonly logger = new Logger(McpClientEngine.name);

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
    }
  }
}
