import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { AuthService } from './auth.service';

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
    '/health',
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  /** The session's user id: from req.user when set, else from the bearer JWT. */
  private userIdOf(req: any): string | undefined {
    if (req?.user?.sub) return req.user.sub;
    const header = req?.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    try {
      return this.authService.verifyToken(header.slice(7)).sub || undefined;
    } catch {
      // Not a session token of ours (an MCP OAuth token, an expired JWT):
      // the route's own authentication deals with it.
      return undefined;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isCloud = this.configService.get<string>('DEPLOYMENT_MODE') === 'cloud';
    if (!isCloud) return true;

    const req = context.switchToHttp().getRequest();
    const userId = this.userIdOf(req);
    if (!userId) return true;

    const path: string = req.path || req.url || '';
    if (EmailVerifiedGuard.PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
      return true;
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true },
    });
    if (!dbUser?.emailVerified) {
      throw new ForbiddenException('Email verification required');
    }
    return true;
  }
}
