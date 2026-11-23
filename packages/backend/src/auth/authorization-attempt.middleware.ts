import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';
import {
  attemptKey,
  authorizationAttemptContext,
  connectedPageArm,
  CONNECTED_PAGE_TEST_ENV,
  deviceOf,
  type AuthorizationAttemptContext,
  signInPageArm,
  SIGNIN_PAGE_TEST_ENV,
} from './authorization-attempt';

/**
 * Lets the `authorization_code_issued` event say which device and which page
 * arm the code was issued for.
 *
 * The OAuth library's `/callback` issues the code through the store, which
 * never sees the request. This middleware runs the rest of the request inside
 * an AsyncLocalStorage that holds the device (from the user agent) and the
 * attempt (looked up from the pending authorization, without waiting for it).
 *
 * Statistics only. It reads one cookie and one row, changes nothing on the
 * request or the response, and whatever goes wrong here the callback runs
 * exactly as it does without it.
 */
@Injectable()
export class AuthorizationAttemptMiddleware implements NestMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly deployment: DeploymentService,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    let context: AuthorizationAttemptContext | null = null;
    try {
      context = this.contextFor(req);
    } catch {
      context = null;
    }
    if (!context) return next();
    authorizationAttemptContext.run(context, next);
  }

  private contextFor(req: Request): AuthorizationAttemptContext | null {
    const sessionId = (req as Request & { cookies?: Record<string, unknown> }).cookies?.oauth_session;
    if (typeof sessionId !== 'string' || !sessionId) return null;
    // Started now, read by the store after the code is stored: the library
    // removes the pending authorization once it has issued the code.
    const attempt = this.prisma.oAuthSession
      .findUnique({ where: { sessionId }, select: { expiresAt: true } })
      .then(
        (row) => (row ? attemptKey(Number(row.expiresAt)) : undefined),
        () => undefined,
      );
    const arm = connectedPageArm(sessionId, {
      cloud: this.deployment.isCloud(),
      setting: this.config.get<string>(CONNECTED_PAGE_TEST_ENV),
    });
    const signinArm = signInPageArm(sessionId, {
      cloud: this.deployment.isCloud(),
      setting: this.config.get<string>(SIGNIN_PAGE_TEST_ENV),
    });
    return {
      device: deviceOf(req.headers['user-agent']),
      attempt,
      ...(arm ? { connectedArm: arm } : {}),
      ...(signinArm ? { signinArm } : {}),
    };
  }
}
