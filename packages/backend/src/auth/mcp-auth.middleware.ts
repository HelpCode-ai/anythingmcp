import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { McpApiKeysService } from '../roles/mcp-api-keys.service';

/**
 * Middleware for authenticating MCP endpoint requests (/mcp).
 *
 * Applied as middleware (not guard) because @rekog/mcp-nest controls
 * the /mcp route directly and guards can't easily be applied to it.
 *
 * Auth methods (checked in order):
 *   1. X-API-Key header → per-user MCP key (mcp_...) or static MCP_API_KEY
 *   2. Bearer token → matches MCP_BEARER_TOKEN env (static) or JWT
 *
 * If no auth is configured, allows all requests (development mode).
 * Returns proper 401 + WWW-Authenticate header for MCP client auth flow.
 */
@Injectable()
export class McpAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger(McpAuthMiddleware.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly mcpApiKeysService: McpApiKeysService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const configuredApiKey = this.configService.get<string>('MCP_API_KEY');
    const mcpBearerToken = this.configService.get<string>('MCP_BEARER_TOKEN');

    const apiKey = req.headers['x-api-key'] as string | undefined;
    const authHeader = req.headers['authorization'] as string | undefined;

    // Check per-user MCP API key first (mcp_... prefix)
    if (apiKey?.startsWith('mcp_')) {
      const user = await this.mcpApiKeysService.resolveUserByKey(apiKey);
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

    // If no auth is configured, allow all (dev mode)
    if (!configuredApiKey && !mcpBearerToken) {
      (req as any).user = { authMethod: 'none' };
      return next();
    }

    // Check static API key
    if (apiKey && configuredApiKey && apiKey === configuredApiKey) {
      (req as any).user = { authMethod: 'static_api_key' };
      return next();
    }

    // Check Bearer token
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Static MCP bearer token
      if (mcpBearerToken && token === mcpBearerToken) {
        (req as any).user = { authMethod: 'static_bearer' };
        return next();
      }

      // JWT token
      try {
        const payload = this.authService.verifyToken(token);
        (req as any).user = { ...payload, authMethod: 'jwt' };
        return next();
      } catch {
        // Invalid JWT — fall through to 401
      }
    }

    // Auth failed — return 401 with WWW-Authenticate
    res.setHeader('WWW-Authenticate', 'Bearer realm="AnythingToMCP MCP Server"');
    res.status(401).json({
      statusCode: 401,
      message: 'Authentication required. Provide a Bearer token or X-API-Key header.',
    });
  }
}
