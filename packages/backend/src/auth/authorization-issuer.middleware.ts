import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';

/**
 * Appends the RFC 9207 `iss` parameter to authorization responses.
 *
 * The MCP 2026-07-28 authorization spec says an authorization server SHOULD
 * include `iss` on the redirect back to the client — including on error
 * responses — so the client can bind the authorization code to the issuer it
 * discovered and detect a mix-up attack before redeeming it.
 *
 * @rekog/mcp-nest builds that redirect itself and has no notion of `iss`, so we
 * wrap `res.redirect` on the callback route rather than fork the controller —
 * the same approach already used for the token and register endpoints.
 *
 * CRITICAL PAIRING: `authorization_response_iss_parameter_supported: true` in
 * the authorization-server metadata and this middleware MUST ship together. A
 * client that reads that flag and then receives a response WITHOUT `iss` is
 * required by the spec to reject it. For the same reason the issuer value is
 * derived here exactly as the metadata document derives it — if the two
 * disagreed (behind a proxy, say) every client would reject every response.
 */
@Injectable()
export class AuthorizationIssuerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuthorizationIssuerMiddleware.name);

  constructor(private readonly config: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const issuer = this.baseUrl(req);
    const originalRedirect = res.redirect.bind(res);

    // Express overloads redirect(url) and redirect(status, url).
    (res as any).redirect = (...args: any[]) => {
      const urlIndex = typeof args[0] === 'number' ? 1 : 0;
      const target = args[urlIndex];

      if (typeof target === 'string') {
        args[urlIndex] = this.withIssuer(target, issuer);
      }

      return originalRedirect(...(args as [any]));
    };

    next();
  }

  /**
   * Adds `iss` only to an actual authorization RESPONSE — the redirect that
   * carries `code` or `error` back to the client. Internal hops (the strategy
   * bouncing to /auth/login, for instance) must be left untouched.
   */
  private withIssuer(target: string, issuer: string): string {
    try {
      const url = new URL(target, issuer);
      const isAuthorizationResponse =
        url.searchParams.has('code') || url.searchParams.has('error');
      if (!isAuthorizationResponse || url.searchParams.has('iss')) {
        return target;
      }
      url.searchParams.set('iss', issuer);
      return url.toString();
    } catch {
      // Not a URL we can parse — leave the redirect exactly as it was rather
      // than risk breaking the flow for the sake of an optional parameter.
      this.logger.debug(`Could not parse redirect target for iss: ${target}`);
      return target;
    }
  }

  /** Must mirror WellKnownOAuthController.baseUrl exactly. */
  private baseUrl(req: Request): string {
    const proto =
      (req.headers['x-forwarded-proto'] as string) ||
      (req.secure ? 'https' : 'http');
    const host =
      (req.headers['x-forwarded-host'] as string) || req.headers.host;
    return host
      ? `${proto}://${host}`
      : this.config.get<string>('SERVER_URL') || 'http://localhost:4000';
  }
}
