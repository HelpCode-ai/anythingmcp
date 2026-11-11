import { Injectable, NestMiddleware, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { isTokenRevoked } from './auth.service';
import { parseOAuthBody } from './oauth-body.util';
import { resolveUserIdFromTokenPayload } from './resolve-user-id.util';
import { CrossWorkspaceRefusalStore } from './cross-workspace-refusal.store';
import { serverReachability } from './server-reachability.util';
import {
  parseAppEndpoint,
  parseDirectoryPlugin,
  parseServerId,
} from './resource-indicator.middleware';

/** What the RFC 8707 `resource` of a refresh request names. */
export type RefreshResourceKind = 'server' | 'global' | 'plugin' | 'none' | 'other';

export function refreshResourceKind(resource: unknown): RefreshResourceKind {
  if (resource === undefined || resource === null || resource === '') return 'none';
  if (typeof resource !== 'string') return 'other';
  if (parseServerId(resource)) return 'server';
  if (parseAppEndpoint(resource) || parseDirectoryPlugin(resource)) return 'plugin';
  try {
    const segments = new URL(resource).pathname.split('/').filter(Boolean);
    if (segments.length === 1 && segments[0] === 'mcp') return 'global';
  } catch {
    // Not a URL.
  }
  return 'other';
}

/** The last 6 characters of an id, for log lines. */
const shortId = (id: string) => `…${id.slice(-6)}`;

const REVOKED_DESCRIPTION = 'This session was revoked. Please sign in again.';
const WRONG_WORKSPACE_DESCRIPTION =
  'This sign-in is not a member of the workspace that owns this MCP server. ' +
  'Connect again and sign in with an account of that workspace, or ask its admin to invite you.';

/**
 * Makes `users.sessionsValidFrom` mean something on the OAuth refresh grant.
 *
 * THE BUG THIS EXISTS FOR. The watermark was enforced on two of the three paths
 * that can present a user token — `JwtStrategy` for the dashboard API and
 * `McpCombinedAuthGuard` for every MCP request — but `POST /token` belongs to
 * `@rekog/mcp-nest-auth`, whose `handleRefreshTokenGrant` mints a new access
 * token straight from the refresh token's claims and consults no user record at
 * all. So a revoked client simply refreshed: the new token carried a fresh
 * `iat`, which sat above the watermark, and `isTokenRevoked` said "fine". With
 * a 30-day refresh lifetime, no rotation and no jti denylist, raising the
 * watermark bought at most one access-token lifetime. Observed in production:
 * a revoked user ran ERP queries 30 minutes later, with three `POST /token →
 * 200` and no `/authorize` in between. The only way to actually cut them off
 * was deleting every row from `oauth_clients`, which forces re-registration on
 * every client of the instance. This middleware retires that workaround.
 *
 * CROSS-WORKSPACE (#1609 follow-up). The same veto refuses a refresh for an
 * MCP server whose workspace the user cannot reach (primary org or active
 * membership, the rule in server-reachability.util). Tokens carry the
 * instance-wide `/mcp` resource, so the server comes from (a) the RFC 8707
 * `resource` the client sends with the refresh, else (b) a marker the MCP
 * endpoint left seconds earlier when it refused this user and client (see
 * CrossWorkspaceRefusalStore). Without this, a client refused with 401 by the
 * endpoint refreshed successfully, retried, was refused again, and never
 * reached the consent page that would tell the person what is wrong.
 *
 * SCOPE. It is a veto, not a second authenticator. Anything that is not a
 * verifiable refresh token — wrong method, wrong grant, bad signature, wrong
 * token type — falls through to `next()` so the upstream controller keeps
 * owning those errors and the two can never disagree.
 *
 * UPSTREAM COUPLING. This depends on the refresh payload shape of
 * @rekog/mcp-nest-auth (`sub`, `type: 'refresh'`, optional `user_profile_id`,
 * HS256 with our JWT_SECRET — see its `jwt-token.service.ts` generateTokenPair
 * and `mcp-oauth.controller.ts` handleRefreshTokenGrant). Re-verify both when
 * bumping that dependency.
 *
 * Never reads the raw request stream — see the note on `parseOAuthBody`.
 */
@Injectable()
export class RefreshTokenRevocationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RefreshTokenRevocationMiddleware.name);

  /**
   * Last audit write per subject. This middleware runs BEFORE ThrottlerGuard,
   * so an unconforming client looping on a rejected refresh could otherwise
   * write a security-event row per attempt. A conforming client cannot loop: it
   * discards its tokens on `invalid_grant` before retrying.
   */
  private readonly lastLoggedAt = new Map<string, number>();
  private static readonly AUDIT_WINDOW_MS = 60_000;

  /** Last "Refresh grant resource" log per client and kind (temporary). */
  private readonly resourceKindLoggedAt = new Map<string, number>();
  private static readonly RESOURCE_KIND_LOG_WINDOW_MS = 60 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly securityEvents: SecurityEventService,
    @Optional() private readonly refusals?: CrossWorkspaceRefusalStore,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    if (req.method !== 'POST') return next();

    const body = parseOAuthBody(req);
    if (body.grant_type !== 'refresh_token') return next();

    const token = body.refresh_token;
    // Missing parameter is upstream's error to report, not ours.
    if (typeof token !== 'string' || !token) return next();

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
    } catch {
      // Malformed, expired or forged — upstream owns the response.
      return next();
    }

    // Upstream checks this too; bailing keeps the error text in one place.
    if (payload?.type !== 'refresh') return next();

    const userId = await resolveUserIdFromTokenPayload(this.prisma, payload);
    if (!userId) {
      // Every refresh token originates from the authorization-code path, so one
      // that verifies against our secret but cannot be attributed to a user is
      // exactly the unrevocable session this middleware exists to eliminate.
      // The cost of a false positive is one automatic re-authorization.
      return this.deny(res, payload, undefined, 'unresolvable_subject');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, sessionsValidFrom: true, organizationId: true },
    });
    // A deleted account leaves no watermark to compare against.
    if (!user) return this.deny(res, payload, userId, 'user_deleted');

    if (isTokenRevoked(payload, user.sessionsValidFrom)) {
      return this.deny(res, payload, userId, 'revoked');
    }

    // Deactivation by itself is covered by the watermark above:
    // `UserLifecycleService` stamps `sessionsValidFrom` in the same transaction.
    // What the watermark cannot see is a token used for a server of a
    // workspace the user never belonged to. The token's own `resource` claim
    // is the instance-wide /mcp, so the server comes from the client: (a) the
    // `resource` it sends now, else (b) the endpoint's marker for this client.
    // Client input is only ever used to refuse. An unknown server or a lookup
    // error falls through, as before.
    const clientId = refreshClientId(payload);
    const kind = refreshResourceKind(body.resource);
    this.noteResourceKind(clientId, kind);

    let serverId: string | null = null;
    let via: 'resource' | 'marker' | null = null;
    if (kind === 'server') {
      serverId = parseServerId(body.resource);
      via = 'resource';
    } else if ((kind === 'none' || kind === 'other') && clientId && this.refusals) {
      // A body naming /mcp or a plugin endpoint told us what it refreshes
      // for, and it is not the refused server: no marker lookup then.
      serverId = await this.refusals.peek(userId, clientId).catch(() => null);
      if (serverId) via = 'marker';
    }

    if (serverId && via) {
      const reach = await serverReachability(this.prisma, userId, serverId, user.organizationId ?? null);
      if (reach === 'unreachable') {
        // The marker is kept: the endpoint re-arms it on every refusal, and a
        // client retrying the same refresh token must be refused again.
        return this.deny(res, payload, userId, 'wrong_workspace', { serverId, via });
      }
      if (via === 'marker' && clientId) {
        // Invited since, or the server is gone: nothing left to refuse.
        await this.refusals?.clear(userId, clientId).catch(() => undefined);
      }
    }
    return next();
  }

  /**
   * TEMPORARY (remove about a week after deploy): whether clients send the
   * RFC 8707 `resource` with a refresh, which decides whether path (b) is
   * needed at all. At most once per client and kind per hour; no token, the
   * client id shortened.
   */
  private noteResourceKind(clientId: string | undefined, kind: RefreshResourceKind) {
    const key = `${clientId ?? 'none'}:${kind}`;
    const now = Date.now();
    const last = this.resourceKindLoggedAt.get(key);
    if (last && now - last < RefreshTokenRevocationMiddleware.RESOURCE_KIND_LOG_WINDOW_MS) return;
    if (this.resourceKindLoggedAt.size > 5000) this.resourceKindLoggedAt.clear();
    this.resourceKindLoggedAt.set(key, now);
    this.logger.log(
      `Refresh grant resource: ${kind} (client ${clientId ? shortId(clientId) : 'none'})`,
    );
  }

  private deny(
    res: Response,
    payload: any,
    userId: string | undefined,
    reason: string,
    detail?: { serverId: string; via: 'resource' | 'marker' },
  ) {
    this.audit(payload, userId, reason, detail);

    // 400 + `invalid_grant`, and the shape matters more than the status. The
    // MCP client branches on the OAuth error CODE: given `invalid_grant` it
    // discards its stored tokens and starts a fresh authorization, which is
    // what we want and is structurally loop-free. Nest's default error body
    // would arrive as code "Bad Request", which the client neither retries nor
    // re-authorizes on — it just fails. And never 401: on the token endpoint
    // that means client authentication failed, which makes clients throw away
    // their dynamic registration too.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(400).json({
      error: 'invalid_grant',
      error_description:
        reason === 'wrong_workspace' ? WRONG_WORKSPACE_DESCRIPTION : REVOKED_DESCRIPTION,
    });
  }

  private audit(
    payload: any,
    userId: string | undefined,
    reason: string,
    detail?: { serverId: string; via: 'resource' | 'marker' },
  ) {
    const key = userId ?? `anon:${payload?.jti ?? 'unknown'}`;
    const now = Date.now();
    const last = this.lastLoggedAt.get(key);
    if (last && now - last < RefreshTokenRevocationMiddleware.AUDIT_WINDOW_MS) {
      return;
    }
    this.lastLoggedAt.set(key, now);

    const what = detail
      ? `${reason} via ${detail.via}, server ${shortId(detail.serverId)}`
      : reason;
    this.logger.warn(
      `Refused refresh_token for ${userId ?? 'unresolvable subject'} (${what})`,
    );
    // No organizationId: the event must not show up in the audit log of the
    // workspace the user is not a member of.
    void this.securityEvents.log({
      event: SecurityEvents.TOKEN_REJECTED,
      actorType: userId ? 'USER' : 'ANONYMOUS',
      targetUserId: userId,
      metadata: { path: '/token', grantType: 'refresh_token', reason, ...(detail ?? {}) },
    });
  }
}

/** The OAuth client a refresh token was issued to (`client_id`; `azp` as a fallback). */
function refreshClientId(payload: any): string | undefined {
  const value = payload?.client_id ?? payload?.azp;
  return typeof value === 'string' && value ? value : undefined;
}
