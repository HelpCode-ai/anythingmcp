import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService, isTokenRevoked } from './auth.service';
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

    // MCP Streamable HTTP: a GET to the endpoint opens (or rejects with 405) an
    // SSE stream. Spec-compliant clients — and Microsoft Copilot Studio's
    // connection probe — expect the transport's own 405 here, not an auth 401.
    // Let GET through: the controller returns 405 in stateless mode (or routes
    // to the authenticated session when a valid mcp-session-id is presented).
    // GET never returns tenant data, so this exposes nothing.
    if (req.method === 'GET') {
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
        // SECURITY: resolve the caller by `users.id` ONLY — never by matching
        // an email claim against `users.email`. `user_data` is the stored OAuth
        // profile copied verbatim into the signed token, so an email-based
        // lookup would let anyone able to influence that profile — an external
        // IdP, once SSO lands — resolve to another organization's user and
        // inherit their `organizationId`, defeating the tenant check below.
        const subId = await this.resolveUserId(payload);

        // The user row is loaded whenever we can identify the caller — not only
        // when the org is missing. Revocation needs `sessionsValidFrom`, and
        // skipping the lookup on the org-present fast path would leave a
        // dashboard JWT presented to /mcp unrevocable (JwtStrategy, which does
        // check, never runs on this route).
        const dbUser = subId
          ? await this.prisma.user.findUnique({
              where: { id: subId },
              select: {
                id: true,
                organizationId: true,
                email: true,
                role: true,
                sessionsValidFrom: true,
              },
            })
          : null;

        if (dbUser && isTokenRevoked(payload, dbUser.sessionsValidFrom)) {
          this.logger.warn(
            `Rejected revoked token for user ${dbUser.id} on ${reqPath}`,
          );
          return this.deny(req, res, reqPath);
        }

        if (!organizationId && subId) {
          organizationId = dbUser?.organizationId ?? undefined;
          req.user = {
            ...payload,
            sub: dbUser?.id ?? subId,
            organizationId,
            email: dbUser?.email ?? payload.email,
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
    return this.deny(req, res, reqPath);
  }

  /**
   * Emits the spec-compliant 401. The MCP spec requires `resource_metadata`
   * pointing at the protected-resource metadata document.
   */
  private deny(req: any, res: any, reqPath: string): boolean {
    const proto =
      (req.headers['x-forwarded-proto'] as string) ||
      (req.secure ? 'https' : 'http');
    const host =
      (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const baseUrl = host ? `${proto}://${host}` : (this.configService.get<string>('SERVER_URL') || 'http://localhost:4000');
    // RFC 9728: the protected-resource metadata URL appends the resource path
    // (e.g. /mcp/<serverId>) to the well-known prefix, so each per-server
    // resource advertises its own metadata. Falls back to the root document.
    const resourceMetadataUrl = reqPath.startsWith('/mcp/')
      ? `${baseUrl}/.well-known/oauth-protected-resource${reqPath}`
      : `${baseUrl}/.well-known/oauth-protected-resource`;

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

  /**
   * Resolves the `users.id` cuid a token belongs to, WITHOUT ever trusting an
   * email claim.
   *
   * Tokens minted after LocalOAuthProvider started mapping the profile
   * `username` to the cuid carry it directly in `sub`.
   *
   * Tokens minted BEFORE that carry the user's email in `sub` — but they also
   * carry `user_profile_id`, and `oauth_user_profiles.external_id` has always
   * stored the cuid (PrismaOAuthStore.upsertUserProfile writes
   * `externalId: profile.id`, and `profile.id` comes from the login cookie's
   * `user.id`). So the cuid is recoverable from authoritative server state,
   * keyed by an opaque identifier that is bound to the signed token.
   *
   * That is why no legacy email fallback is needed: previously-issued sessions
   * keep working, and the mutable, IdP-supplied `email` claim never takes part
   * in identity resolution.
   */
  private async resolveUserId(payload: any): Promise<string | undefined> {
    const sub: string | undefined = payload?.sub;

    // Modern tokens: `sub` is already the cuid. Emails are the only other
    // shape we have ever put there, so an '@' is a reliable discriminator.
    if (sub && !sub.includes('@')) return sub;

    const profileId: string | undefined = payload?.user_profile_id;
    if (profileId) {
      const profile = await this.prisma.oAuthUserProfile.findUnique({
        where: { profileId },
        select: { externalId: true },
      });
      if (profile?.externalId) return profile.externalId;
    }

    // Legacy token with no recoverable profile → fail closed. Returning the
    // email here would reintroduce the email-keyed lookup this method exists
    // to remove.
    return undefined;
  }
}
