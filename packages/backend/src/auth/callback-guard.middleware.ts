import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { deviceOf, pageLanguageFor } from './authorization-attempt';
import { renderClosedRequestPage } from './auth-page';
import { boundLoginUser, clearLoginUserCookie, pendingAuthorizationId } from './login-user-cookie';

/** The user id of the sign-in bound to this request's authorization, or null. */
function signedInUserId(req: Request): string | null {
  const raw = boundLoginUser(req);
  if (!raw) return null;
  try {
    const id = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Cookies of the page after approving; cleared with the sign-in once the code is out. */
const PAUSED_PAGE_COOKIES = ['first_offer'];

/**
 * In front of the OAuth library's `GET /callback`.
 *
 * 1. A browser that arrives without an open authorization (it expired after
 *    30 minutes, or its code was already issued: a second press on Continue,
 *    the Back button, a restored tab) used to get the library's raw JSON
 *    `{"statusCode":400,"message":"Missing OAuth session"}`. It now gets a
 *    page that says what to do.
 * 2. Once the code is on its way to the client, the sign-in cookie is cleared:
 *    it was issued for that one authorization (login-user-cookie.ts) and has
 *    no further use.
 *
 * Whatever goes wrong in here, the callback runs as it does without it.
 */
@Injectable()
export class CallbackGuardMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CallbackGuardMiddleware.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly deployment: DeploymentService,
    private readonly productEvents: ProductEventService,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'GET') return next();
    void this.check(req).then(
      (verdict) => {
        if (verdict === 'closed') return this.closed(req, res);
        if (verdict === 'no-grant') return this.closed(req, res, 'callback-no-grant');
        this.clearSignInWithTheCode(res);
        next();
      },
      () => next(),
    );
  }

  /**
   * 'closed': no pending authorization, or it expired. 'no-grant': the
   * signed-in person would get a code for a client that has no grant (no
   * active `mcp_connection_grants` row): what it may reach was never decided,
   * so no code is issued. 'open' otherwise. A database problem while looking
   * up the authorization counts as open (the library answers); while looking
   * up the grant, as no grant.
   */
  private async check(req: Request): Promise<'open' | 'closed' | 'no-grant'> {
    const sessionId = pendingAuthorizationId(req);
    if (!sessionId) return 'closed';
    let row: { expiresAt: bigint; clientId: string | null } | null;
    try {
      row = await this.prisma.oAuthSession.findUnique({
        where: { sessionId },
        select: { expiresAt: true, clientId: true },
      });
    } catch (err) {
      // A database problem is not an expired request: let the library answer.
      this.logger.warn(`Could not look up the pending authorization (${(err as Error)?.name ?? 'error'})`);
      return 'open';
    }
    if (!row || Number(row.expiresAt) < Date.now()) return 'closed';
    return (await this.hasGrant(req, row.clientId)) ? 'open' : 'no-grant';
  }

  /**
   * Whether the person this callback would issue a code to has an active
   * grant for the client. Without a signed-in person for this authorization
   * the library sends the browser back to the sign-in page and issues
   * nothing, so there is nothing to check.
   */
  private async hasGrant(req: Request, clientId: string | null): Promise<boolean> {
    const userId = signedInUserId(req);
    if (!userId || !clientId) return true;
    try {
      const grant = await this.prisma.mcpConnectionGrant.findUnique({
        where: { clientId_userId: { clientId, userId } },
        select: { revokedAt: true },
      });
      if (grant && !grant.revokedAt) return true;
      this.logger.warn(`No code issued: client ${clientId} has no grant for user ${userId}`);
      return false;
    } catch (err) {
      this.logger.warn(`Could not look up the grant for a callback (${(err as Error)?.name ?? 'error'})`);
      return false;
    }
  }

  private closed(req: Request, res: Response, via: 'callback' | 'callback-no-grant' = 'callback'): void {
    // How often this happens was unknown before: count it (Cloud only, no account).
    if (this.deployment.isCloud()) {
      void this.productEvents
        .log({
          event: ProductEvents.AUTHORIZE_REQUEST_CLOSED,
          metadata: { device: deviceOf(req.headers['user-agent']), via },
        })
        .catch(() => undefined);
    }
    clearLoginUserCookie(res);
    res.status(400);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(
      renderClosedRequestPage({
        trust: { cloud: this.deployment.isCloud() },
        dashboardUrl: this.dashboardUrl(),
        // No open authorization, so no page-test arm: the browser's language.
        lang: pageLanguageFor(req.headers?.['accept-language']),
      }),
    );
  }

  /**
   * Wraps `res.redirect`: the redirect that carries `code` back to the client
   * is the moment the authorization is finished. Internal hops (the strategy
   * sending the browser to /auth/login) are left as they are.
   */
  private clearSignInWithTheCode(res: Response): void {
    const originalRedirect = res.redirect.bind(res);
    (res as any).redirect = (...args: any[]) => {
      const target = args[typeof args[0] === 'number' ? 1 : 0];
      try {
        if (typeof target === 'string' && new URL(target, 'http://internal.invalid').searchParams.has('code')) {
          clearLoginUserCookie(res);
          for (const name of PAUSED_PAGE_COOKIES) res.clearCookie(name);
        }
      } catch {
        // Not a URL we can parse: redirect exactly as before.
      }
      return originalRedirect(...(args as [any]));
    };
  }

  private dashboardUrl(): string | undefined {
    const url = this.config.get<string>('FRONTEND_URL') || this.config.get<string>('SERVER_URL');
    return url ? url.replace(/\/+$/, '') : undefined;
  }
}
