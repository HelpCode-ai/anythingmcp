import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { McpApiKeysService } from '../roles/mcp-api-keys.service';

/**
 * Combined auth guard for per-server MCP endpoints (/mcp/:serverId).
 *
 * Handles all auth modes (none, legacy, oauth2, both) in a single guard,
 * so we don't depend on middleware configuration in AppModule.
 *
 * Auth methods (checked in order):
 *   1. X-API-Key header → per-user MCP key (mcp_...) or static MCP_API_KEY
 *   2. Bearer token → JWT (OAuth) or static MCP_BEARER_TOKEN
 *   3. If auth mode is 'none' → allow all
 */
@Injectable()
export class McpCombinedAuthGuard implements CanActivate {
  private readonly logger = new Logger(McpCombinedAuthGuard.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly mcpApiKeysService: McpApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const mode = this.configService.get<string>('MCP_AUTH_MODE') || 'none';
    const configuredApiKey = this.configService.get<string>('MCP_API_KEY');
    const mcpBearerToken = this.configService.get<string>('MCP_BEARER_TOKEN');

    const apiKey = req.headers['x-api-key'] as string | undefined;
    const authHeader = req.headers['authorization'] as string | undefined;

    // 1. Check per-user MCP API key (mcp_... prefix)
    if (apiKey?.startsWith('mcp_')) {
      const user = await this.mcpApiKeysService.resolveUserByKey(apiKey);
      if (user) {
        req.user = {
          sub: user.id,
          email: user.email,
          role: user.role,
          mcpRoleId: user.mcpRoleId,
          mcpServerId: user.mcpServerId,
        };
        return true;
      }
      // Invalid key — continue to check other methods
    }

    // 2. Check static API key (legacy mode)
    if (apiKey && configuredApiKey && apiKey === configuredApiKey) {
      return true;
    }

    // 3. Check Bearer token (JWT or static)
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Static MCP bearer token
      if (mcpBearerToken && token === mcpBearerToken) {
        return true;
      }

      // JWT token (OAuth or legacy JWT)
      try {
        const payload = this.authService.verifyToken(token);
        req.user = payload;
        return true;
      } catch {
        // Invalid JWT — continue
      }
    }

    // 4. If auth mode is 'none', allow all
    if (mode === 'none') {
      return true;
    }

    // 5. If no auth is configured at all (dev mode), allow
    if (!configuredApiKey && !mcpBearerToken && mode !== 'oauth2') {
      return true;
    }

    // Auth failed — build proper WWW-Authenticate header for MCP OAuth flow
    // The MCP spec requires resource_metadata pointing to the protected resource metadata
    const proto =
      (req.headers['x-forwarded-proto'] as string) ||
      (req.secure ? 'https' : 'http');
    const host =
      (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const baseUrl = host ? `${proto}://${host}` : (this.configService.get<string>('SERVER_URL') || 'http://localhost:4000');
    const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="AnythingToMCP MCP Server", resource_metadata="${resourceMetadataUrl}"`,
    );
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authentication required.' },
      id: null,
    });
    return false;
  }
}
