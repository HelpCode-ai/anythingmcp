import { Injectable, Logger, NestMiddleware, Optional } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../common/prisma.service';

/** Token-endpoint auth methods that prove possession of a client secret. */
const SECRET_AUTH_METHODS = new Set(['client_secret_basic', 'client_secret_post']);

/** Client ids listed in OAUTH_PKCE_EXEMPT_CLIENT_IDS (comma-separated). */
export function pkceExemptClientIds(): string[] {
  return (process.env.OAUTH_PKCE_EXEMPT_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** True when the operator listed at least one PKCE-exempt client. */
export function pkceExemptionsConfigured(): boolean {
  return pkceExemptClientIds().length > 0;
}

/**
 * Enforces PKCE with S256 on GET /authorize.
 *
 * @rekog/mcp-nest validates a code challenge only when one happens to be
 * present (`if (authCode.code_challenge)` in its token handler), never requires
 * it at /authorize, and defaults the method to `plain`. Combined with open
 * Dynamic Client Registration that leaves the authorization code — which
 * travels in a query string, through browser history and proxy logs —
 * interceptable and replayable by any client that can register.
 *
 * `plain` is rejected as well as absent: it stores the verifier in the clear on
 * the authorization request, so it defends against nothing an attacker who can
 * read the request cannot already do.
 *
 * This is what the MCP authorization spec requires of clients, so a conforming
 * client is unaffected. Runs as middleware for the same reason
 * ClientCredentialsMiddleware and OAuthRegisterGuardMiddleware do: it lets us
 * hold the line without forking the upstream controller.
 *
 * Errors are returned as a 400 JSON body rather than redirected to
 * `redirect_uri`. Redirecting would require trusting a client-supplied URI
 * before it has been validated against a registration, which is exactly how an
 * authorization endpoint becomes an open redirector.
 *
 * ONE EXCEPTION. Some platforms cannot send PKCE at all: Power Platform
 * connectors (Microsoft Copilot Studio) run a plain OAuth 2.0 authorization
 * code flow with a client secret. An operator can list such clients in
 * `OAUTH_PKCE_EXEMPT_CLIENT_IDS`; a listed client may omit the challenge only
 * while its registration is confidential (client_secret_basic/post with a
 * stored secret). The token endpoint then refuses the code without that
 * secret, which is what PKCE would otherwise protect, and the code is still
 * bound to the client's registered redirect URI. A request that does carry a
 * challenge is validated as usual, and a client registered through open DCR is
 * never exempt unless the operator names it.
 */
@Injectable()
export class AuthorizePkceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthorizePkceMiddleware.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Only the authorization request itself carries PKCE parameters.
    if (req.method !== 'GET') {
      return next();
    }

    const query = req.query as Record<string, unknown>;
    const challenge = query.code_challenge;
    const method = query.code_challenge_method;

    if (typeof challenge !== 'string' || challenge.trim() === '') {
      if (
        method === undefined &&
        (await this.isExemptConfidentialClient(query.client_id))
      ) {
        return next();
      }
      this.logger.warn(
        `Rejecting /authorize without PKCE (client_id=${String(query.client_id ?? '<none>')})`,
      );
      return this.reject(
        res,
        'code_challenge is required. This server requires PKCE with S256.',
      );
    }

    if (method !== 'S256') {
      this.logger.warn(
        `Rejecting /authorize with code_challenge_method='${String(method ?? '<none>')}'`,
      );
      return this.reject(
        res,
        "code_challenge_method must be 'S256'. 'plain' and an absent method are not accepted.",
      );
    }

    // S256 challenges are the base64url encoding of a SHA-256 digest: 43
    // characters, no padding. Checking the shape stops a malformed value from
    // silently never matching any verifier at the token endpoint.
    if (!/^[A-Za-z0-9\-._~]{43}$/.test(challenge)) {
      return this.reject(
        res,
        'code_challenge is not a valid base64url-encoded SHA-256 digest.',
      );
    }

    next();
  }

  /**
   * True only for a client the operator listed in OAUTH_PKCE_EXEMPT_CLIENT_IDS
   * whose registration requires a client secret at the token endpoint. The
   * database is consulted only for listed ids, so ordinary requests never pay
   * for a lookup.
   */
  private async isExemptConfidentialClient(clientId: unknown): Promise<boolean> {
    if (typeof clientId !== 'string' || !clientId) return false;
    if (!pkceExemptClientIds().includes(clientId) || !this.prisma) return false;

    try {
      const client = await this.prisma.oAuthClient.findUnique({
        where: { clientId },
        select: { tokenEndpointAuthMethod: true, clientSecret: true },
      });
      if (
        client &&
        SECRET_AUTH_METHODS.has(client.tokenEndpointAuthMethod) &&
        !!client.clientSecret
      ) {
        return true;
      }
      this.logger.warn(
        `Client ${clientId} is listed in OAUTH_PKCE_EXEMPT_CLIENT_IDS but is not a confidential client; PKCE stays required`,
      );
    } catch (err) {
      this.logger.warn(
        `PKCE exemption lookup failed for ${clientId}: ${(err as Error).message}`,
      );
    }
    return false;
  }

  private reject(res: Response, description: string): void {
    res
      .status(400)
      .header('Content-Type', 'application/json')
      .json({ error: 'invalid_request', error_description: description });
  }
}
