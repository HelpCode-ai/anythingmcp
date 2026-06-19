import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { McpApiKeysService } from '../roles/mcp-api-keys.service';
import { PrismaService } from '../common/prisma.service';

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
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // Public demo MCP server: a static, tenant-less, anonymous endpoint at the
    // EXACT path /mcp/demo. Its handler exposes only self-describing info tools
    // and never resolves a serverId or touches the database, so allowing
    // anonymous access here cannot expose any tenant data. Match the exact path
    // only — every other /mcp/:serverId stays fail-closed below.
    const reqPath = (req.path || req.url || '').split('?')[0].replace(/\/+$/, '');
    if (reqPath === '/mcp/demo') {
      req.user = { authMethod: 'none' };
      return true;
    }

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
          organizationId: user.organizationId,
          mcpRoleId: user.mcpRoleId,
          mcpServerId: user.mcpServerId,
          authMethod: 'mcp_api_key',
          apiKeyName: user.apiKeyName,
        };
        return true;
      }
      // Invalid key — continue to check other methods
    }

    // 2. Check static API key (legacy mode)
    if (apiKey && configuredApiKey && apiKey === configuredApiKey) {
      req.user = { authMethod: 'static_api_key' };
      return true;
    }

    // 3. Check Bearer token (JWT or static)
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // Static MCP bearer token
      if (mcpBearerToken && token === mcpBearerToken) {
        req.user = { authMethod: 'static_bearer' };
        return true;
      }

      // JWT token (OAuth or legacy JWT)
      try {
        const payload = this.authService.verifyToken(token) as any;
        // App JWTs carry `organizationId` in their claims. OAuth access tokens
        // issued by the MCP OAuth flow only carry `sub` + `user_data` (no org).
        // Resolve the organization from the user record so the per-server
        // tenant-isolation check can be enforced — without this, OAuth clients
        // would have `organizationId === undefined` and bypass isolation,
        // allowing cross-organization access to any /mcp/:serverId endpoint.
        let organizationId: string | undefined =
          payload.organizationId ?? undefined;
        // The MCP OAuth flow (rekog/mcp-nest) signs `sub` with whatever
        // identifier the auth code carried — in our integration that's the
        // user's EMAIL, not the `users.id` cuid. App JWTs, by contrast, put
        // the cuid in `sub`. So we can't assume `sub` is a primary key:
        // resolve the user by id OR email, trying every identifier the token
        // exposes. Without this, OAuth callers resolve to `organizationId ===
        // undefined` and the downstream per-server tenant check fails closed
        // with 403 — locking legitimate owners out of their own servers.
        const subId: string | undefined = payload.sub || payload.user_data?.id;
        const email: string | undefined =
          payload.email ?? payload.user_data?.email ?? undefined;
        if (!organizationId && (subId || email)) {
          // `sub` may itself be an email; collect every candidate and match
          // on id OR email in a single query.
          const ids = [subId].filter(
            (v): v is string => !!v && !v.includes('@'),
          );
          const emails = [email, subId].filter(
            (v): v is string => !!v && v.includes('@'),
          );
          const dbUser = await this.prisma.user.findFirst({
            where: {
              OR: [
                ...ids.map((id) => ({ id })),
                ...emails.map((e) => ({ email: e })),
              ],
            },
            select: { id: true, organizationId: true, email: true, role: true },
          });
          organizationId = dbUser?.organizationId ?? undefined;
          req.user = {
            ...payload,
            sub: dbUser?.id ?? subId,
            organizationId,
            email: dbUser?.email ?? email,
            role: payload.role ?? dbUser?.role,
            authMethod: 'jwt',
          };
        } else {
          req.user = { ...payload, organizationId, authMethod: 'jwt' };
        }
        return true;
      } catch {
        // Invalid JWT — continue
      }
    }

    // 4. If auth mode is 'none', allow all
    if (mode === 'none') {
      req.user = { authMethod: 'none' };
      return true;
    }

    // 5. Legacy mode with no credentials configured: refuse by default (fail
    // closed). Allow anonymous access only when explicitly opted in via
    // MCP_ALLOW_ANONYMOUS=true, for trusted local/dev use.
    if (
      mode === 'legacy' &&
      !configuredApiKey &&
      !mcpBearerToken &&
      this.configService.get<string>('MCP_ALLOW_ANONYMOUS') === 'true'
    ) {
      req.user = { authMethod: 'none' };
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
      `Bearer realm="AnythingMCP MCP Server", resource_metadata="${resourceMetadataUrl}"`,
    );
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authentication required.' },
      id: null,
    });
    return false;
  }
}
