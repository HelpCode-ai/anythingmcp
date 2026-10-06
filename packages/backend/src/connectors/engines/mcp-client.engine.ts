import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OAuth2TokenService } from './oauth2-token.service';
import { assertSafeOutboundUrl } from '../../common/ssrf.util';
import { DEFAULT_MCP_PATH, resolveMcpEndpointUrl } from '../../common/url.util';
import { ssrfGuardedFetch } from '../../common/outbound-http';

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
    assertNotThisServer(mcpUrl);
    await assertSafeOutboundUrl(mcpUrl.toString());

    const headers: Record<string, string> = { ...config.headers };
    await this.injectAuth(headers, config.authType, config.authConfig, config.connectorId);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      fetch: ssrfGuardedFetch,
      requestInit: { headers },
    });

    const client = new Client({
      name: 'anythingmcp-bridge',
      version: '1.0.0',
    });

    const sentAt = Date.now();
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
        const newToken = await this.oauth2TokenService.renewAfterRejection(
          config.authConfig,
          config.connectorId,
          sentAt,
        );
        if (newToken) {
          const retryHeaders: Record<string, string> = { ...config.headers };
          retryHeaders['Authorization'] = `Bearer ${newToken}`;

          const retryTransport = new StreamableHTTPClientTransport(mcpUrl, {
            fetch: ssrfGuardedFetch,
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
    assertNotThisServer(mcpUrl);
    await assertSafeOutboundUrl(mcpUrl.toString());

    const headers: Record<string, string> = { ...config.headers };
    await this.injectAuth(headers, config.authType, config.authConfig, config.connectorId);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      fetch: ssrfGuardedFetch,
      requestInit: { headers },
    });

    const client = new Client({
      name: 'anythingmcp-bridge',
      version: '1.0.0',
    });

    try {
      try {
        await client.connect(transport);
      } catch (err) {
        throw explainMcpConnectError(err, mcpUrl);
      }
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

/**
 * The public hosts of this AnythingMCP instance (SERVER_URL, FRONTEND_URL,
 * CLOUD_PUBLIC_URL), lower-cased, with the port when it is not the default:
 * another MCP server on the same machine (localhost:8080 next to
 * localhost:4000) is a different server.
 */
export function thisServerHostnames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const raw of [env.SERVER_URL, env.FRONTEND_URL, env.CLOUD_PUBLIC_URL]) {
    if (!raw) continue;
    try {
      out.add(new URL(raw).host.toLowerCase());
    } catch {
      /* not a URL: ignore */
    }
  }
  return out;
}

/**
 * An MCP connector pointing at this very server makes every call re-enter
 * our own /mcp, which calls the connector again: an endless loop that holds
 * a request for the full timeout at each hop. On 4 Oct 2026 one such
 * connector ("Claude Etsy", URL cloud.anythingmcp.com) made 13,709 calls in
 * two hours, each timing out after 60 s, and doubled everyone's p95.
 */
export function assertNotThisServer(mcpUrl: URL, env: NodeJS.ProcessEnv = process.env): void {
  if (!thisServerHostnames(env).has(mcpUrl.host.toLowerCase())) return;
  throw new Error(
    `This MCP connector points at this AnythingMCP server itself (${mcpUrl.host}), so every call ` +
      `would call itself again in a loop. Its tools are already here: use this server's own connectors ` +
      `instead, and point an MCP connector only at another MCP server.`,
  );
}

/**
 * A remote MCP server built on the MCP SDK with DNS-rebinding protection on
 * answers 403 "Invalid Host header" / "host not allowed" to any hostname it
 * was not told about, e.g. its own public tunnel (trycloudflare, ngrok). The
 * raw message reads like our fault; say which setting on their side to change.
 */
export function explainMcpConnectError(err: unknown, mcpUrl: URL): Error {
  const message = String((err as Error)?.message ?? err);
  if (!/invalid host header|host not allowed|dns rebinding/i.test(message)) {
    return err instanceof Error ? err : new Error(message);
  }
  const explained = new Error(
    `${message}. The MCP server refused the hostname '${mcpUrl.hostname}': its DNS-rebinding ` +
      `protection only accepts the hosts it was configured with. Add '${mcpUrl.hostname}' to the ` +
      `server's allowed hosts (allowedHosts in the MCP SDK; with a tunnel, the tunnel's hostname) ` +
      `or turn that check off behind the tunnel, then discover the tools again.`,
  );
  (explained as Error & { cause?: unknown }).cause = err;
  return explained;
}

