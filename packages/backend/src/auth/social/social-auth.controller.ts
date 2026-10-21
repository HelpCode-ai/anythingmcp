import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request, Response } from 'express';
import { CloudOnlyGuard } from '../../common/cloud-only.guard';
import { SignupAttributionDto } from '../signup-attribution.dto';
import {
  SOCIAL_BIND_COOKIE,
  SOCIAL_BIND_COOKIE_PATH,
  SocialAuthError,
  SocialAuthService,
} from './social-auth.service';

class SocialStartDto {
  @ApiProperty({ description: "Provider id: 'google', 'microsoft' or 'github'." })
  @IsString()
  provider: string;

  @ApiPropertyOptional({ description: 'Internal path to return to after sign-in. Anything external is ignored.' })
  @IsOptional()
  @IsString()
  redirect?: string;

  @ApiPropertyOptional({ description: 'Sign-up attribution, as sent with the email sign-up.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => SignupAttributionDto)
  attribution?: SignupAttributionDto;
}

class SocialExchangeDto {
  @ApiProperty({ description: 'One-time code from the sign-in redirect.' })
  @IsString()
  code: string;
}

class SocialLinkDto {
  @ApiPropertyOptional({ description: 'Internal path to return to. Anything external is ignored.' })
  @IsOptional()
  @IsString()
  redirect?: string;
}

/** Sets the cookie that binds a round trip to this browser. */
export function setSocialBindCookie(req: Request, res: Response, token: string): void {
  const secure =
    req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  res.cookie(SOCIAL_BIND_COOKIE, token, {
    httpOnly: true,
    secure,
    // Lax is enough: the provider brings the browser back with a top-level GET.
    sameSite: 'lax',
    path: SOCIAL_BIND_COOKIE_PATH,
    maxAge: 10 * 60 * 1000,
  });
}

function badRequest(err: unknown): never {
  if (err instanceof SocialAuthError) throw new BadRequestException(err.userMessage);
  throw err;
}

/**
 * Cloud social sign-in, dashboard side. The provider callback itself is
 * `GET /auth/social/:provider/callback` on {@link LoginController}, because
 * the MCP authorization flow has to finish there.
 */
@ApiTags('Auth')
@UseGuards(CloudOnlyGuard)
@Controller('api/auth/social')
export class SocialAuthController {
  constructor(private readonly social: SocialAuthService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start signing in or up with a social provider (Cloud only)' })
  async start(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: SocialStartDto) {
    try {
      const { authorizationUrl, bindingToken } = await this.social.start({
        provider: dto.provider,
        surface: 'DASHBOARD',
        returnTo: dto.redirect,
        attribution: dto.attribution ? (JSON.parse(JSON.stringify(dto.attribution)) as Record<string, unknown>) : null,
      });
      setSocialBindCookie(req, res, bindingToken);
      return { authorizationUrl };
    } catch (err) {
      badRequest(err);
    }
  }

  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange the one-time sign-in code for a session' })
  async exchange(@Body() dto: SocialExchangeDto) {
    try {
      return await this.social.exchange(dto.code);
    } catch (err) {
      if (err instanceof SocialAuthError) throw new UnauthorizedException(err.userMessage);
      throw err;
    }
  }

  @Get('identities')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Social providers the signed-in user can connect, and which are connected' })
  async identities(@Req() req: any) {
    return this.social.listForUser(req.user.sub);
  }

  @Post('link/:provider')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Start connecting a social provider to the signed-in account' })
  async link(
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Param('provider') provider: string,
    @Body() dto: SocialLinkDto,
  ) {
    try {
      const { authorizationUrl, bindingToken } = await this.social.start({
        provider,
        surface: 'LINK',
        linkUserId: req.user.sub,
        returnTo: dto?.redirect ?? '/settings',
      });
      setSocialBindCookie(req, res, bindingToken);
      return { authorizationUrl };
    } catch (err) {
      badRequest(err);
    }
  }

  @Delete('link/:provider')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disconnect a social provider from the signed-in account' })
  async unlink(@Req() req: any, @Param('provider') provider: string) {
    try {
      await this.social.unlink(req.user.sub, provider, {
        ip: req.ip,
        userAgent: req.headers?.['user-agent'],
      });
      return { unlinked: true };
    } catch (err) {
      badRequest(err);
    }
  }
}
