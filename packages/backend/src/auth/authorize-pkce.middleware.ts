import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

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
 */
@Injectable()
export class AuthorizePkceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthorizePkceMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // Only the authorization request itself carries PKCE parameters.
    if (req.method !== 'GET') {
      return next();
    }

    const query = req.query as Record<string, unknown>;
    const challenge = query.code_challenge;
    const method = query.code_challenge_method;

    if (typeof challenge !== 'string' || challenge.trim() === '') {
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

  private reject(res: Response, description: string): void {
    res
      .status(400)
      .header('Content-Type', 'application/json')
      .json({ error: 'invalid_request', error_description: description });
  }
}
