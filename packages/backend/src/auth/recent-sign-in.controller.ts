import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { RecentSignInService, type RecentSignInSession } from './recent-sign-in.service';
import { RECENT_SIGN_IN_COOKIE, hasDashboardHeader } from './recent-sign-in.util';

/**
 * "Continue as …" on the dashboard sign-in page, for a browser that signed in
 * on the authorization page a short while ago (see RecentSignInService).
 * Offered, never automatic: the user clicks it, and signing out of the
 * dashboard forgets it.
 */
@ApiTags('Auth')
@Controller('api/auth/recent-sign-in')
export class RecentSignInController {
  private readonly logger = new Logger(RecentSignInController.name);

  constructor(private readonly recent: RecentSignInService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'The account this browser recently signed in with, if any' })
  async who(@Req() req: Request, @Res() res: Response) {
    const user = await this.recent.user(req);
    if (!user) return res.status(204).end();
    return res.json({ email: user.email, name: user.name });
  }

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open a dashboard session from the recent sign-in' })
  async continue(@Req() req: Request): Promise<RecentSignInSession> {
    if (!hasDashboardHeader(req)) throw new UnauthorizedException('Sign in to continue.');
    const user = await this.recent.user(req);
    const session = user ? await this.recent.session(user.id) : null;
    if (!session) throw new UnauthorizedException('Sign in to continue.');
    this.logger.log(`Dashboard session from the recent sign-in of user ${user!.id}`);
    return session;
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Forget the recent sign-in (dashboard sign-out)' })
  forget(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(RECENT_SIGN_IN_COOKIE, { path: '/' });
  }
}
