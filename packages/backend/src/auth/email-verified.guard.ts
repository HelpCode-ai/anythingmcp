import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { AuthService } from './auth.service';
import { resolveUserIdFromTokenPayload } from './resolve-user-id.util';
import { SocialProviderRegistry } from './social/social-providers';
import {
  emailVerificationNotice,
  McpEmailVerificationRequiredException,
} from './mcp-email-verification';

/**
 * In cloud mode, users must verify their email before they can access any
 * non-auth endpoint. Self-hosted deployments are unaffected.
 *
 * Applied globally via APP_GUARD. The allowlist below covers the endpoints
 * needed to *complete* the verification flow (and to log out).
 *
 * Global guards run before a route's own AuthGuard('jwt'), so `req.user` is
 * not set yet when this one runs. It used to return early on that and never
 * checked anything: an unverified cloud account could call every endpoint.
 * It now reads the session token itself.
 *
 * It only judges accounts that exist. A token whose user is gone (a deleted
 * workspace, a legacy token whose `sub` was an email) is not "unverified": it
 * is the route's own authentication that refuses it, with a 401 an MCP client
 * answers by signing in again. Answering 403 here kept such clients retrying
 * the same dead token forever.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  private static readonly PATH_ALLOWLIST = [
    '/api/auth/verify-email',
    '/api/auth/verify-email-link',
    '/api/auth/resend-verification',
    '/api/auth/logout',
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/accept-invite',
    // Social sign-in: starting it and exchanging its one-time code.
    '/api/auth/social/start',
    '/api/auth/social/exchange',
    // Unverified users must reach support (e.g. the code never arrived).
    '/api/support/widget',
    '/health',
  ];

  private readonly logger = new Logger(EmailVerifiedGuard.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    @Optional() private readonly socialProviders?: SocialProviderRegistry,
  ) {}

  /** The session's user id: from req.user when set, else from the bearer JWT. */
  private async userIdOf(req: any): Promise<string | undefined> {
    if (req?.user?.sub) return req.user.sub;
    const header = req?.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    let payload: any;
    try {
      payload = this.authService.verifyToken(header.slice(7));
    } catch {
      // Not a session token of ours (an MCP API key, an expired JWT):
      // the route's own authentication deals with it.
      return undefined;
    }
    // The same resolution as the MCP auth guard: a legacy token carries an
    // email in `sub`, which is never a users.id.
    return resolveUserIdFromTokenPayload(this.prisma, payload);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isCloud = this.configService.get<string>('DEPLOYMENT_MODE') === 'cloud';
    if (!isCloud) return true;

    const req = context.switchToHttp().getRequest();
    const userId = await this.userIdOf(req);
    if (!userId) return true;

    const path: string = req.path || req.url || '';
    if (EmailVerifiedGuard.PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
      return true;
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true, email: true },
    });
    // Unknown user: not ours to judge (see the class comment).
    if (!dbUser) return true;
    if (!dbUser.emailVerified) {
      if (path.startsWith('/mcp')) {
        this.logger.warn(`Refused ${path}: user ${userId} has not verified their email`);
        // The person otherwise only sees the connection fail: on 9-10 Oct
        // 2026 seven people who had connected Claude retried up to 122 times
        // without knowing what was missing. McpEmailVerificationFilter turns
        // this into an MCP answer the client shows and the model can read.
        const dashboard = this.configService.get<string>('FRONTEND_URL') || 'https://cloud.anythingmcp.com';
        throw new McpEmailVerificationRequiredException(
          emailVerificationNotice(
            dashboard,
            dbUser.email,
            this.socialProviders?.enabled().map((p) => p.name) ?? [],
          ),
        );
      }
      throw new ForbiddenException('Email verification required');
    }
    return true;
  }
}
