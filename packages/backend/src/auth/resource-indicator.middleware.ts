import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/** Name of the signed cookie carrying the client's requested resource. */
export const MCP_RESOURCE_COOKIE = 'mcp_resource';

/**
 * Captures the RFC 8707 `resource` indicator the client sends to /authorize.
 *
 * The MCP 2026-07-28 authorization spec makes `resource` mandatory on both the
 * authorization and token requests, and tells clients to send "the most
 * specific URI that they can" — explicitly blessing the
 * `https://host/mcp/<serverId>` form when the path is what identifies an
 * individual MCP server.
 *
 * @rekog/mcp-nest throws that away: its /authorize handler does
 * `const resource = this.options.resource`, ignoring the query parameter, so
 * every session and every token records the same instance-wide value. The
 * consequence worth knowing is that token audiences are NOT per-server — a
 * token minted for one workspace's server is audience-valid for another's, and
 * only the application-level tenant check in McpEndpointController stops it.
 * Fixing that properly means owning the authorization server; capturing the
 * value here is the fork-free half we can do now.
 *
 * WHAT THIS VALUE MAY BE USED FOR: choosing which identity-provider button to
 * render on the login page. Nothing else. It is unauthenticated client input —
 * it must never influence which organization a session belongs to, which role
 * a user receives, or any authorization decision. The authoritative org comes
 * from the identity provider record after authentication.
 *
 * Stored in a signed, httpOnly cookie so it survives the redirect to
 * /auth/login without a schema change, and cannot be forged by a script.
 */
@Injectable()
export class ResourceIndicatorMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ResourceIndicatorMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET') return next();

    const raw = (req.query as Record<string, unknown>).resource;
    const serverId = typeof raw === 'string' ? parseServerId(raw) : null;

    if (serverId) {
      const isSecure =
        req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(MCP_RESOURCE_COOKIE, serverId, {
        httpOnly: true,
        secure: isSecure,
        // Long enough to survive the hop to the login page and back, short
        // enough that a stale value cannot influence a later flow.
        maxAge: 10 * 60 * 1000,
        sameSite: isSecure ? 'none' : 'lax',
        signed: true,
      });
    } else {
      // Clear any value left by an earlier flow, so a previous server's IdP
      // buttons are never shown for this one.
      res.clearCookie(MCP_RESOURCE_COOKIE);
    }

    next();
  }
}

/**
 * Extracts the MCP server id from a resource indicator, or null when the value
 * is the instance-wide `/mcp` resource or anything unrecognised.
 *
 * Only the shape is checked here. Whether the server exists — and which
 * organization owns it — is resolved later, at the point of use.
 */
export function parseServerId(resource: string): string | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  // Expect exactly ['mcp', '<serverId>']; bare ['mcp'] is the global resource.
  if (segments.length !== 2 || segments[0] !== 'mcp') return null;

  const serverId = segments[1];
  // Server ids are cuids. Constrain the shape so a hostile value cannot be
  // smuggled into a downstream lookup or a rendered page.
  return /^[a-z0-9]{20,40}$/i.test(serverId) ? serverId : null;
}
