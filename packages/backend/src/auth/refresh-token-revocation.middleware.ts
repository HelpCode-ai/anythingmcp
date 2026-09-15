import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';
import { isTokenRevoked } from './auth.service';
import { parseOAuthBody } from './oauth-body.util';
import { resolveUserIdFromTokenPayload } from './resolve-user-id.util';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly securityEvents: SecurityEventService,
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
      select: { id: true, sessionsValidFrom: true },
    });
    // A deleted account leaves no watermark to compare against.
    if (!user) return this.deny(res, payload, userId, 'user_deleted');

    if (isTokenRevoked(payload, user.sessionsValidFrom)) {
      return this.deny(res, payload, userId, 'revoked');
    }

    // Deactivation is deliberately NOT checked here: it is per-membership, and
    // `UserLifecycleService` stamps `sessionsValidFrom` in the same transaction,
    // so the watermark above already covers it. Re-deriving org membership from
    // the `resource` claim would duplicate what `getAllowedToolIds` enforces
    // fail-closed on every request.
    return next();
  }

  private deny(
    res: Response,
    payload: any,
    userId: string | undefined,
    reason: string,
  ) {
    this.audit(payload, userId, reason);

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
      error_description: 'This session was revoked. Please sign in again.',
    });
  }

  private audit(payload: any, userId: string | undefined, reason: string) {
    const key = userId ?? `anon:${payload?.jti ?? 'unknown'}`;
    const now = Date.now();
    const last = this.lastLoggedAt.get(key);
    if (last && now - last < RefreshTokenRevocationMiddleware.AUDIT_WINDOW_MS) {
      return;
    }
    this.lastLoggedAt.set(key, now);

    this.logger.warn(
      `Refused refresh_token for ${userId ?? 'unresolvable subject'} (${reason})`,
    );
    void this.securityEvents.log({
      event: SecurityEvents.TOKEN_REJECTED,
      actorType: userId ? 'USER' : 'ANONYMOUS',
      targetUserId: userId,
      metadata: { path: '/token', grantType: 'refresh_token', reason },
    });
  }
}
