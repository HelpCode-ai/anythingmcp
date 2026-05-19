import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';

/**
 * In cloud mode, users must verify their email before they can access any
 * non-auth endpoint. Self-hosted deployments are unaffected.
 *
 * Applied globally via APP_GUARD. The allowlist below covers the endpoints
 * needed to *complete* the verification flow (and to log out).
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isCloud = this.configService.get<string>('DEPLOYMENT_MODE') === 'cloud';
    if (!isCloud) return true;

    const req = context.switchToHttp().getRequest();
    const user = req?.user;
    if (!user?.sub) return true;

    const path: string = req.path || req.url || '';
    if (EmailVerifiedGuard.PATH_ALLOWLIST.some((p) => path.startsWith(p))) {
      return true;
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { emailVerified: true },
    });
    if (!dbUser?.emailVerified) {
      throw new ForbiddenException('Email verification required');
    }
    return true;
  }
}
