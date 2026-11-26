import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { parseOAuthBody } from './oauth-body.util';

/**
 * Answers POST /token requests with grant_type=client_credentials: it refuses
 * every one of them with `unauthorized_client` (RFC 6749 §5.2).
 *
 * The @rekog/mcp-nest McpAuthModule only handles authorization_code and
 * refresh_token. This middleware used to add client_credentials on top by
 * checking the client id and secret against `oauth_clients` and signing a JWT
 * with `sub: "client:<id>"`. That was wrong for two reasons:
 *
 *  - Every row in `oauth_clients` comes from open Dynamic Client Registration
 *    (POST /register, upstream `ClientService.registerClient` →
 *    `PrismaOAuthStore.storeClient`; nothing else writes the table, and it has
 *    no column recording who created a client). Anyone on the internet can
 *    register a client with `grant_types: ["client_credentials"]` and a
 *    secret, so the grant handed a signed access token to anonymous callers.
 *    In a real attack on a self-hosted instance that is exactly what happened.
 *  - The token was useless to legitimate callers anyway: it names no user, so
 *    the MCP endpoint refuses it (`McpCombinedAuthGuard`: unknown user) and so
 *    does the dashboard API (`JwtStrategy`: foreign token claims). Machines
 *    reach an MCP server with a per-user MCP API key (`mcp_…`) instead.
 *
 * Because no client can be told apart from a self-registered one, no client is
 * authorized for this grant. The refusal happens before any database lookup
 * or secret comparison, so the endpoint is neither a client-id nor a secret
 * oracle, and it costs nothing under a flood. The grant is no longer
 * advertised in the authorization server metadata either.
 *
 * Runs before the upstream controller on the /token route (app.module.ts);
 * every other grant passes through untouched.
 */
@Injectable()
export class ClientCredentialsMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ClientCredentialsMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    if (req.method !== 'POST') {
      return next();
    }

    const body = parseOAuthBody(req);
    if (body.grant_type !== 'client_credentials') {
      return next();
    }

    // The client id is attacker-supplied: logged only in a sanitized, bounded
    // form. The secret is never read beyond what is needed to drop it.
    this.logger.warn(
      `Refused client_credentials grant for client ${loggableClientId(req, body)} ` +
        `from ${req.ip ?? 'unknown'}: clients from dynamic client registration ` +
        'are not authorized for this grant',
    );

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(400).json({
      error: 'unauthorized_client',
      error_description:
        'The client_credentials grant is not available on this server. ' +
        'Use the authorization code flow, or a per-user MCP API key for machine access.',
    });
  }
}

/**
 * The client id from HTTP Basic auth or the body, reduced to characters a
 * client id plausibly contains and capped in length, so a crafted value cannot
 * forge log lines or flood them. Never returns any part of the secret.
 */
export function loggableClientId(
  req: Request,
  body: Record<string, any>,
): string {
  let clientId: unknown = body.client_id;
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const sep = decoded.indexOf(':');
    clientId = sep >= 0 ? decoded.slice(0, sep) : decoded;
  }
  if (typeof clientId !== 'string' || clientId.length === 0) return '<none>';
  const safe = clientId.replace(/[^A-Za-z0-9._:-]/g, '?').slice(0, 64);
  return clientId.length > 64 ? `${safe}…` : safe;
}
