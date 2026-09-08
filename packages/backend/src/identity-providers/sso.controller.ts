import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiExcludeEndpoint,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { IsString, IsOptional } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SsoService, SsoError } from './sso.service';
import { SecurityEventService, SecurityEvents } from '../audit/security-event.service';

class SsoExchangeDto {
  @ApiProperty({ description: 'One-time code from the sign-in redirect.' })
  @IsString()
  code: string;
}

class SsoLinkStartDto {
  @ApiPropertyOptional({
    description: 'Internal path to return to. Anything external is ignored.',
  })
  @IsOptional()
  @IsString()
  redirect?: string;
}

/**
 * Link failures that must return the user to their settings page, with wording
 * that tells them what to do. Every other reason keeps the deliberately generic
 * sign-in message: those routes are unauthenticated and must not become an
 * oracle for which workspaces and accounts exist.
 */
const LINK_FAILURE_REASONS = new Map<string, string>([
  [
    'identity_already_linked_to_another_user',
    'That directory account is already connected to a different user.',
  ],
  [
    'user_already_linked_at_provider',
    'Your account is already connected to this provider. Disconnect it first to use a different directory account.',
  ],
  ['not_a_member', 'You are no longer a member of this workspace.'],
  ['link_without_user', 'The link request expired. Please try again.'],
]);

/**
 * Public sign-in routes. No JWT guard: this IS the authentication.
 *
 * Every failure returns the same generic message and redirects to the same
 * place. The specific reason goes to the audit trail, never to the caller —
 * distinguishing "unknown provider" from "you are not a member" would turn
 * these endpoints into an enumeration oracle for workspaces and accounts.
 */
@ApiTags('SSO')
@Controller()
export class SsoController {
  private readonly logger = new Logger(SsoController.name);

  constructor(
    private readonly sso: SsoService,
    private readonly config: ConfigService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('SERVER_URL') ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  @Get('sso/:initiateId')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start sign-in with an identity provider' })
  async start(
    @Param('initiateId') initiateId: string,
    @Query('redirect') redirect: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const { authorizationUrl } = await this.sso.start(initiateId, redirect);
      return res.redirect(authorizationUrl);
    } catch (error) {
      await this.logFailure(error, req, { initiateId });
      return res.redirect(
        `${this.frontendUrl()}/login?error=${encodeURIComponent('Sign-in is unavailable. Please contact your administrator.')}`,
      );
    }
  }

  @Get('auth/sso/callback')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async callback(@Req() req: Request, @Res() res: Response) {
    const frontend = this.frontendUrl();
    try {
      // Rebuilt from server-side config, never from the request host: a spoofed
      // `x-forwarded-host` must not be able to influence the URL the OIDC
      // library validates the response against.
      const currentUrl = new URL(
        `${frontend}${req.originalUrl}`.replace(/([^:]\/)\/+/g, '$1'),
      );

      const result = await this.sso.complete(currentUrl, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.setHeader('Referrer-Policy', 'no-referrer');

      if (result.kind === 'LINK') {
        // The caller was already signed in, so there is no session to hand
        // over — just report the outcome on the page they came from.
        const target = new URL(
          `${frontend}${result.returnTo === '/' ? '/settings' : result.returnTo}`,
        );
        target.searchParams.set('linked', '1');
        return res.redirect(303, target.href);
      }

      // The session token is NOT in this URL — only a 30-second, single-use
      // code the SPA trades for it. A JWT here would land in browser history,
      // the Referer header and every proxy log on the way.
      const target = new URL(`${frontend}/login`);
      target.searchParams.set('sso', result.handoffCode);
      if (result.returnTo && result.returnTo !== '/') {
        target.searchParams.set('redirect', result.returnTo);
      }
      return res.redirect(303, target.href);
    } catch (error) {
      const reason = error instanceof SsoError ? error.reason : 'unexpected';
      await this.logFailure(error, req, {});
      // A link failure must land back on the settings page, not the sign-in
      // page: bouncing an already-authenticated user to /login looks like
      // being signed out and invites them to re-enter their password.
      if (LINK_FAILURE_REASONS.has(reason)) {
        return res.redirect(
          303,
          `${frontend}/settings?linkError=${encodeURIComponent(LINK_FAILURE_REASONS.get(reason)!)}`,
        );
      }
      return res.redirect(
        `${frontend}/login?error=${encodeURIComponent('Sign-in failed. Please try again or contact your administrator.')}`,
      );
    }
  }

  @Post('api/auth/sso/link/:providerId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Begin connecting an identity provider to your own account',
  })
  async startLink(
    @Req() req: any,
    @Param('providerId') providerId: string,
    @Body() dto: SsoLinkStartDto,
  ) {
    try {
      // Returns the URL instead of redirecting: the browser must arrive at the
      // provider through a top-level navigation the SPA performs, and a
      // redirect on an XHR would be followed invisibly by fetch instead.
      return await this.sso.startLink(req.user.sub, providerId, dto?.redirect);
    } catch (error) {
      await this.logFailure(error, req, { providerId });
      throw new BadRequestException(
        'This identity provider is not available for your account.',
      );
    }
  }

  @Delete('api/auth/sso/link/:providerId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect an identity provider from your account' })
  async unlink(@Req() req: any, @Param('providerId') providerId: string) {
    try {
      await this.sso.unlink(req.user.sub, providerId, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return { message: 'Identity disconnected' };
    } catch (error) {
      const reason = error instanceof SsoError ? error.reason : 'unexpected';
      await this.logFailure(error, req, { providerId });
      // Specific on purpose, unlike the sign-in routes: the caller is
      // authenticated and acting on their own account, so there is nothing to
      // enumerate — and "it failed" would leave them with no idea what to do.
      if (reason === 'would_lock_account_out') {
        throw new BadRequestException(
          'Set a password first — disconnecting this provider would leave you with no way to sign in.',
        );
      }
      if (reason === 'identity_not_linked') {
        throw new NotFoundException('That provider is not connected.');
      }
      throw new BadRequestException('Could not disconnect this provider.');
    }
  }

  @Get('api/auth/sso/providers')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Identity providers you can connect, and whether you have',
  })
  async myProviders(@Req() req: any) {
    if (!req.user.organizationId) return [];
    return this.sso.availableForUser(req.user.sub, req.user.organizationId);
  }

  @Post('api/auth/sso/exchange')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Trade a one-time sign-in code for a session' })
  async exchange(@Body() dto: SsoExchangeDto, @Req() req: Request) {
    try {
      return await this.sso.exchange(dto.code);
    } catch (error) {
      await this.logFailure(error, req, {});
      // Deliberately the same 401 for expired, replayed and forged codes.
      return { error: 'Sign-in code is invalid or has expired' };
    }
  }

  private async logFailure(
    error: unknown,
    req: Request,
    metadata: Record<string, unknown>,
  ) {
    const reason =
      error instanceof SsoError ? error.reason : 'unexpected_error';
    this.logger.warn(
      `SSO failure (${reason}): ${(error as Error)?.message ?? error}`,
    );
    // The service already wrote a richer event for this one — with the
    // organization, provider and subject. Writing again here would add a
    // second, context-free row for the same refusal.
    if (error instanceof SsoError && error.audited) return;
    await this.securityEvents.log({
      event: SecurityEvents.SSO_LOGIN_FAILED,
      actorType: 'ANONYMOUS',
      metadata: { ...metadata, reason },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
