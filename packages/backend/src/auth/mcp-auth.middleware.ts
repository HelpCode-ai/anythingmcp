import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { McpApiKeysService } from '../roles/mcp-api-keys.service';
import { presentedMcpApiKey } from './mcp-api-key.util';

/**
 * Middleware in front of the MCP endpoints (/mcp, /mcp/:serverId) in the
 * 'legacy' and 'both' auth modes (see AppModule.configure).
 *
 * McpCombinedAuthGuard runs after it on every MCP route and is the one place
 * that decides who the caller is: it verifies JWTs (signature, revocation,
 * organization), per-user mcp_ keys and the static credentials, and answers a
 * missing credential with the 401 + `resource_metadata` an OAuth client needs
 * to start its flow. This middleware only adds the 'legacy' rule that predates
 * it: with no static credential configured, an MCP request is refused unless
 * MCP_ALLOW_ANONYMOUS=true.
 *
 * 'both' passes straight through. OAuth is enabled there, and refusing here
 * whenever no static credential was configured is what kept OAuth clients
 * (Claude, ChatGPT) from connecting in that mode; the guard now treats 'both'
 * exactly like 'oauth2', plus the static credentials when they are set.
 */
@Injectable()
export class McpAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(McpAuthMiddleware.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly mcpApiKeysService: McpApiKeysService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const mode = this.configService.get<string>('MCP_AUTH_MODE') || 'none';
    if (mode !== 'legacy') return next();

    const configuredApiKey = this.configService.get<string>('MCP_API_KEY');
    const mcpBearerToken = this.configService.get<string>('MCP_BEARER_TOKEN');

    const apiKey = req.headers['x-api-key'] as string | undefined;
    const authHeader = req.headers['authorization'] as string | undefined;

    // Check per-user MCP API key first (mcp_... prefix), from X-API-Key or
    // Authorization: Bearer (see presentedMcpApiKey).
    const presentedKey = presentedMcpApiKey(req.headers, mcpBearerToken);
    if (presentedKey) {
      const user = await this.mcpApiKeysService.resolveUserByKey(presentedKey);
      if (user) {
        (req as any).user = {
          sub: user.id, email: user.email, role: user.role,
          mcpRoleId: user.mcpRoleId, mcpServerId: user.mcpServerId,
          authMethod: 'mcp_api_key', apiKeyName: user.apiKeyName,
        };
        return next();
      }
      // Invalid per-user key — fall through to 401
    }

    // If no MCP credentials are configured, refuse by default (fail closed).
    // Anonymous access is allowed only when explicitly opted in via
    // MCP_ALLOW_ANONYMOUS=true, for trusted local/dev use. This prevents a
    // default deployment from silently exposing configured MCP tools to
    // unauthenticated network clients.
    if (!configuredApiKey && !mcpBearerToken) {
      const allowAnonymous =
        this.configService.get<string>('MCP_ALLOW_ANONYMOUS') === 'true';
      if (allowAnonymous) {
        (req as any).user = { authMethod: 'none' };
        return next();
      }
      this.logger.warn(
        'MCP request refused: no MCP_API_KEY/MCP_BEARER_TOKEN configured and MCP_ALLOW_ANONYMOUS is not enabled.',
      );
      res.setHeader('WWW-Authenticate', 'Bearer realm="AnythingMCP MCP Server"');
      res.status(401).json({
        statusCode: 401,
        message:
          'MCP authentication is not configured. Set MCP_API_KEY or MCP_BEARER_TOKEN, or set MCP_ALLOW_ANONYMOUS=true for trusted local use.',
      });
      return;
    }

    // Check static API key
    if (apiKey && configuredApiKey && apiKey === configuredApiKey) {
      (req as any).user = { authMethod: 'static_api_key' };
      return next();
    }

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Static MCP bearer token
      if (mcpBearerToken && token === mcpBearerToken) {
        (req as any).user = { authMethod: 'static_bearer' };
        return next();
      }

      // Any other bearer token may be a JWT. It is verified by
      // McpCombinedAuthGuard, which also checks revocation and resolves the
      // organization; verifying it here as well only duplicated that, without
      // either check. An mcp_ key that did not resolve above is no JWT.
      if (!presentedKey) return next();
    }

    // Auth failed — return 401 with WWW-Authenticate
    res.setHeader('WWW-Authenticate', 'Bearer realm="AnythingMCP MCP Server"');
    res.status(401).json({
      statusCode: 401,
      message: 'Authentication required. Provide a Bearer token or X-API-Key header.',
    });
  }
}
