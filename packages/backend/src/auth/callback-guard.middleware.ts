import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import { ProductEvents, ProductEventService } from '../audit/product-event.service';
import { deviceOf } from './authorization-attempt';
import { renderClosedRequestPage } from './auth-page';
import { clearLoginUserCookie, pendingAuthorizationId } from './login-user-cookie';

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
    void this.isOpen(req).then(
      (open) => {
        if (!open) return this.closed(req, res);
        this.clearSignInWithTheCode(res);
        next();
      },
      () => next(),
    );
  }

  /** True when this browser has a pending authorization that has not expired. Errors count as open. */
  private async isOpen(req: Request): Promise<boolean> {
    const sessionId = pendingAuthorizationId(req);
    if (!sessionId) return false;
    try {
      const row = await this.prisma.oAuthSession.findUnique({ where: { sessionId }, select: { expiresAt: true } });
      return !!row && Number(row.expiresAt) >= Date.now();
    } catch (err) {
      // A database problem is not an expired request: let the library answer.
      this.logger.warn(`Could not look up the pending authorization (${(err as Error)?.name ?? 'error'})`);
      return true;
    }
  }

  private closed(req: Request, res: Response): void {
    // How often this happens was unknown before: count it (Cloud only, no account).
    if (this.deployment.isCloud()) {
      void this.productEvents
        .log({
          event: ProductEvents.AUTHORIZE_REQUEST_CLOSED,
          metadata: { device: deviceOf(req.headers['user-agent']), via: 'callback' },
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
