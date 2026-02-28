import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';

/**
 * Middleware for authenticating MCP endpoint requests (/mcp).
 *
 * Applied as middleware (not guard) because @rekog/mcp-nest controls
 * the /mcp route directly and guards can't easily be applied to it.
 *
 * Auth methods (checked in order):
 *   1. X-API-Key header → matches MCP_API_KEY env
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
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    const configuredApiKey = this.configService.get<string>('MCP_API_KEY');
    const mcpBearerToken = this.configService.get<string>('MCP_BEARER_TOKEN');

    // If no auth is configured, allow all (dev mode)
    if (!configuredApiKey && !mcpBearerToken) {
      return next();
    }

    const apiKey = req.headers['x-api-key'] as string | undefined;
    const authHeader = req.headers['authorization'] as string | undefined;

    // Check API key
    if (apiKey && configuredApiKey && apiKey === configuredApiKey) {
      return next();
    }

    // Check Bearer token
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Static MCP bearer token
      if (mcpBearerToken && token === mcpBearerToken) {
        return next();
      }

      // JWT token
      try {
        const payload = this.authService.verifyToken(token);
        (req as any).user = payload;
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
