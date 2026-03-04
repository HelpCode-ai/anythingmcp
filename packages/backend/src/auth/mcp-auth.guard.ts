import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { McpApiKeysService } from '../roles/mcp-api-keys.service';

/**
 * Guard for the MCP endpoint (/mcp).
 * Supports:
 *   - Per-user MCP API key (mcp_... prefix → resolves user + role)
 *   - Bearer token (JWT from AnythingMCP auth)
 *   - Bearer token (static MCP_BEARER_TOKEN for Claude Desktop)
 *   - X-API-Key header (static MCP_API_KEY for Claude Desktop)
 *
 * Returns proper 401 with WWW-Authenticate header so Claude Desktop
 * and other MCP clients can handle auth correctly.
 *
 * If no MCP auth is configured (MCP_API_KEY and MCP_BEARER_TOKEN both empty),
 * allows all requests (development mode).
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  private readonly logger = new Logger(McpAuthGuard.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
    private readonly mcpApiKeysService: McpApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const authHeader = request.headers['authorization'];
    const apiKey = request.headers['x-api-key'];

    const configuredApiKey = this.configService.get<string>('MCP_API_KEY');
    const mcpBearerToken = this.configService.get<string>('MCP_BEARER_TOKEN');

    // Check per-user MCP API key first (mcp_... prefix)
    if (apiKey?.startsWith('mcp_')) {
      const user = await this.mcpApiKeysService.resolveUserByKey(apiKey);
      if (user) {
        request.user = { sub: user.id, email: user.email, role: user.role, mcpRoleId: user.mcpRoleId };
        return true;
      }
      // Invalid per-user key — fall through to 401
    }

    // If no auth is configured, allow (dev mode)
    if (!configuredApiKey && !mcpBearerToken) {
      this.logger.warn(
        'MCP endpoint has no auth configured — allowing all requests',
      );
      return true;
    }

    // Check static API key
    if (apiKey && configuredApiKey && apiKey === configuredApiKey) {
      return true;
    }

    // Check Bearer token
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Check static MCP bearer token first
      if (mcpBearerToken && token === mcpBearerToken) {
        return true;
      }

      // Check JWT token
      try {
        const payload = this.authService.verifyToken(token);
        request.user = payload;
        return true;
      } catch {
        // Invalid token — fall through to 401
      }
    }

    // Set WWW-Authenticate header for proper MCP client auth flow
    response.setHeader(
      'WWW-Authenticate',
      'Bearer realm="AnythingMCP MCP Server"',
    );

    this.logger.warn('MCP auth failed — returning 401');
    throw new UnauthorizedException({
      statusCode: 401,
      message: 'Authentication required. Provide a Bearer token or X-API-Key header.',
      hint: 'Configure MCP_BEARER_TOKEN or MCP_API_KEY in the server, then use it in your MCP client config.',
    });
  }
}
