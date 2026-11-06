import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

/** Name of the signed cookie carrying the client's requested resource. */
export const MCP_RESOURCE_COOKIE = 'mcp_resource';

/**
 * Name of the signed cookie carrying which fixed plugin endpoint the client
 * asked for (`/mcp/file-search`), when it named one. Separate from
 * MCP_RESOURCE_COOKIE, which only ever holds a server id.
 */
export const MCP_APP_COOKIE = 'mcp_app';

/**
 * The fixed plugin endpoints whose authorization adds a step of its own: the
 * File Search plugin offers to connect a folder after "Approve". The database
 * plugin (`/mcp/chatgpt-app`) has none and is deliberately not listed.
 */
export const APP_ENDPOINTS = ['file-search'] as const;
export type AppEndpoint = (typeof APP_ENDPOINTS)[number];

/**
 * The endpoints of AnythingMCP's plugins in OpenAI's plugin directory. An
 * authorization for one of them marks a sign-up that came from the ChatGPT
 * directory (see audit/directory-signup.ts). Kept in its own signed cookie:
 * like MCP_APP_COOKIE it is unauthenticated client input, used for the
 * sign-up report only.
 */
export const DIRECTORY_PLUGIN_ENDPOINTS = ['chatgpt-app', 'file-search'] as const;
export type DirectoryPluginEndpoint = (typeof DIRECTORY_PLUGIN_ENDPOINTS)[number];
export const MCP_DIRECTORY_COOKIE = 'mcp_directory';

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

    const app = typeof raw === 'string' ? parseAppEndpoint(raw) : null;
    if (app) {
      const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(MCP_APP_COOKIE, app, {
        httpOnly: true,
        secure: isSecure,
        // As long as the authorization it belongs to may stay paused (30 min).
        maxAge: 30 * 60 * 1000,
        sameSite: isSecure ? 'none' : 'lax',
        signed: true,
      });
    } else {
      res.clearCookie(MCP_APP_COOKIE);
    }

    const plugin = typeof raw === 'string' ? parseDirectoryPlugin(raw) : null;
    if (plugin) {
      const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(MCP_DIRECTORY_COOKIE, plugin, {
        httpOnly: true,
        secure: isSecure,
        // Sign-up, checkout and Approve can take a while; 30 min like MCP_APP_COOKIE.
        maxAge: 30 * 60 * 1000,
        sameSite: isSecure ? 'none' : 'lax',
        signed: true,
      });
    } else {
      res.clearCookie(MCP_DIRECTORY_COOKIE);
    }

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

/**
 * The fixed plugin endpoint a resource indicator names (`https://host/mcp/file-search`),
 * or null. Like the server id, unauthenticated client input: it may only pick
 * which optional page follows "Approve" (the File Search setup offer), never
 * whom a session belongs to or what it may reach.
 */
export function parseAppEndpoint(resource: string): AppEndpoint | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'mcp') return null;
  return (APP_ENDPOINTS as readonly string[]).includes(segments[1]) ? (segments[1] as AppEndpoint) : null;
}

/** The directory plugin endpoint a resource indicator names (`https://host/mcp/chatgpt-app`), or null. */
export function parseDirectoryPlugin(resource: string): DirectoryPluginEndpoint | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0] !== 'mcp') return null;
  return (DIRECTORY_PLUGIN_ENDPOINTS as readonly string[]).includes(segments[1])
    ? (segments[1] as DirectoryPluginEndpoint)
    : null;
}
