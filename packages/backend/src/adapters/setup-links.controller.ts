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
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ConnectorSetupService } from './connector-setup.service';
import { RecentSignInService, type RecentSignInSession } from '../auth/recent-sign-in.service';
import { hasDashboardHeader } from '../auth/recent-sign-in.util';

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
    private readonly recent: RecentSignInService,
  ) {}

  @Post('resolve')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtOrManagementKeyGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open a connector setup link with the dashboard session' })
  async resolve(
    @Req() req: any,
    @Body() body: { token?: string; from?: string },
  ): Promise<{ redirect: string; session?: RecentSignInSession }> {
    // `from` only picks the setup page's way back, from a fixed list.
    const out = await this.setup.resolveLink(String(body?.token ?? ''), req.user.sub, body?.from);
    if ('error' in out) throw new GoneException(out.error);
    // The session is on another workspace than the connector: switch, as the
    // workspace menu would, or the setup page could not save anything.
    if (out.organizationId !== req.user.organizationId) {
      const session = await this.recent.session(req.user.sub, out.organizationId);
      return session ? { redirect: out.redirect, session } : { redirect: out.redirect };
    }
    return { redirect: out.redirect };
  }

  /**
   * The same, for a browser without a dashboard session that has just signed
   * in on the authorization page (RecentSignInService): typically someone who
   * connected Claude a few minutes ago and was handed this link. It needs both
   * the link and that browser's signed cookie, for the same user; anything
   * else is told to sign in, as before.
   */
  @Post('open')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open a connector setup link right after signing in to connect an AI client' })
  async open(
    @Req() req: Request,
    @Body() body: { token?: string; from?: string },
  ): Promise<{ redirect: string; session: RecentSignInSession }> {
    // Only from the dashboard page itself (see RECENT_SIGN_IN_HEADER).
    const user = hasDashboardHeader(req) ? await this.recent.user(req) : null;
    if (!user) throw new UnauthorizedException(SIGN_IN_AGAIN);

    const out = await this.setup.resolveLink(String(body?.token ?? ''), user.id, body?.from);
    // A link made for another account, in a browser signed in as this one:
    // the normal sign-in lets them pick the right account.
    if ('error' in out) throw new UnauthorizedException(out.error);
    const session = await this.recent.session(user.id, out.organizationId);
    if (!session) throw new UnauthorizedException(SIGN_IN_AGAIN);
    this.logger.log(`Opened a setup link with the recent sign-in of user ${user.id}`);
    return { redirect: out.redirect, session };
  }
}
