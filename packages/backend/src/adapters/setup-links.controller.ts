import {
  Body,
  Controller,
  GoneException,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ConnectorSetupService } from './connector-setup.service';
import { AuthService, isTokenRevoked } from '../auth/auth.service';
import { SsoEnforcementService } from '../auth/sso-enforcement.service';
import { readRecentSignIn } from '../auth/recent-sign-in.util';
import { OrganizationsService } from '../organizations/organizations.service';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';

/** A dashboard session for the link's workspace, when the browser needs one. */
interface SetupLinkSession {
  accessToken: string;
  user: { id: string; email: string; name: string | null; role: string; organizationId: string | null };
}

const SIGN_IN_AGAIN = 'Sign in to open this link.';

/**
 * Opening a setup link (/s/<token> in the dashboard). A link only opens for
 * the user it was made for, so one forwarded or leaked from a chat opens
 * nothing for anyone else.
 */
@ApiTags('Connector setup')
@Controller('api/setup-links')
export class SetupLinksController {
  private readonly logger = new Logger(SetupLinksController.name);

  constructor(
    private readonly setup: ConnectorSetupService,
    private readonly authService: AuthService,
    private readonly organizations: OrganizationsService,
    private readonly ssoEnforcement: SsoEnforcementService,
    private readonly prisma: PrismaService,
    private readonly deployment: DeploymentService,
  ) {}

  @Post('resolve')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open a connector setup link with the dashboard session' })
  async resolve(
    @Req() req: any,
    @Body() body: { token?: string; from?: string },
  ): Promise<{ redirect: string; session?: SetupLinkSession }> {
    // `from` only picks the setup page's way back, from a fixed list.
    const out = await this.setup.resolveLink(String(body?.token ?? ''), req.user.sub, body?.from);
    if ('error' in out) throw new GoneException(out.error);
    // The session is on another workspace than the connector: switch, as the
    // workspace menu would, or the setup page could not save anything.
    if (out.organizationId !== req.user.organizationId) {
      return { redirect: out.redirect, session: await this.sessionFor(req.user.sub, out.organizationId) };
    }
    return { redirect: out.redirect };
  }

  /**
   * The same, for a browser without a dashboard session that has just signed
   * in on the authorization page (the RECENT_SIGN_IN_COOKIE): typically
   * someone who connected Claude a few minutes ago and was handed this link.
   * It needs both the link and that browser's signed cookie, for the same
   * user; anything else is told to sign in, as before.
   */
  @Post('open')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open a connector setup link right after signing in to connect an AI client' })
  async open(
    @Req() req: Request,
    @Body() body: { token?: string; from?: string },
  ): Promise<{ redirect: string; session: SetupLinkSession }> {
    const signIn = readRecentSignIn(req);
    if (!signIn) throw new UnauthorizedException(SIGN_IN_AGAIN);

    const user = await this.prisma.user.findUnique({
      where: { id: signIn.userId },
      select: { id: true, emailVerified: true, sessionsValidFrom: true },
    });
    if (!user || isTokenRevoked({ iat: signIn.iat }, user.sessionsValidFrom)) {
      throw new UnauthorizedException(SIGN_IN_AGAIN);
    }
    if (this.deployment.isCloud() && !user.emailVerified) throw new UnauthorizedException(SIGN_IN_AGAIN);
    // A workspace that requires its own sign-in (SSO) gets it: this shortcut
    // must not stand in for the IdP's MFA and Conditional Access.
    if (await this.ssoEnforcement.isPasswordLoginBlocked(user.id)) {
      throw new UnauthorizedException(SIGN_IN_AGAIN);
    }

    const out = await this.setup.resolveLink(String(body?.token ?? ''), user.id, body?.from);
    if ('error' in out) {
      // A link made for another account, in a browser signed in as this one:
      // the normal sign-in lets them pick the right account.
      throw new UnauthorizedException(out.error);
    }
    this.logger.log(`Opened a setup link with the recent sign-in of user ${user.id}`);
    return { redirect: out.redirect, session: await this.sessionFor(user.id, out.organizationId) };
  }

  private async sessionFor(userId: string, organizationId: string): Promise<SetupLinkSession> {
    const user = await this.organizations.switchOrg(userId, organizationId);
    return {
      accessToken: this.authService.generateToken({
        sub: user.id,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
        mcpRoleId: user.mcpRoleId,
      }),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
      },
    };
  }
}
