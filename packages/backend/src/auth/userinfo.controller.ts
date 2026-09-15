import {
  Controller,
  Get,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { PrismaService } from '../common/prisma.service';

/**
 * OpenID Connect UserInfo for the MCP authorization server.
 *
 * ChatGPT Enterprise can restrict a plugin to accounts of the company's own
 * e-mail domain, but only if the authorization server says who the user is:
 * an OIDC discovery document, the `openid` and `email` scopes, and a UserInfo
 * endpoint returning `email` with `email_verified: true`. Without this the
 * plugin still works, but no Enterprise admin can scope it to their domain.
 *
 * The bearer token is the same access token the MCP endpoint accepts. The
 * user is resolved by `sub` (the users.id cuid) or, for older tokens, via the
 * OAuth profile — never by matching an e-mail claim, for the same reason the
 * MCP guard refuses to (see McpCombinedAuthGuard.resolveUserId).
 */
@ApiExcludeController()
@Controller('userinfo')
export class UserInfoController {
  private readonly logger = new Logger(UserInfoController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  get(@Req() req: Request, @Res() res: Response) {
    return this.respond(req, res);
  }

  // RFC 6749 §7 / OIDC Core §5.3.1: POST with the token in the header is
  // equally valid, and some relying parties use it.
  @Post()
  post(@Req() req: Request, @Res() res: Response) {
    return this.respond(req, res);
  }

  private async respond(req: Request, res: Response) {
    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && /^bearer\s+/i.test(header)
        ? header.replace(/^bearer\s+/i, '').trim()
        : undefined;
    if (!token) return this.unauthorized(res, false);

    let payload: any;
    try {
      payload = this.authService.verifyToken(token);
    } catch {
      return this.unauthorized(res, true);
    }

    const userId = await this.resolveUserId(payload);
    const user = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, emailVerified: true, name: true },
        })
      : null;
    if (!user) return this.unauthorized(res, true);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      sub: user.id,
      email: user.email,
      email_verified: user.emailVerified === true,
      ...(user.name ? { name: user.name } : {}),
    });
  }

  private async resolveUserId(payload: any): Promise<string | undefined> {
    const sub: string | undefined = payload?.sub;
    if (sub && !sub.includes('@')) return sub;
    const profileId: string | undefined = payload?.user_profile_id;
    if (profileId) {
      const profile = await this.prisma.oAuthUserProfile.findUnique({
        where: { profileId },
        select: { externalId: true },
      });
      if (profile?.externalId) return profile.externalId;
    }
    return undefined;
  }

  private unauthorized(res: Response, tokenWasPresented: boolean) {
    // RFC 6750: no error code when no token was sent at all.
    res.setHeader(
      'WWW-Authenticate',
      tokenWasPresented
        ? 'Bearer realm="AnythingMCP", error="invalid_token"'
        : 'Bearer realm="AnythingMCP"',
    );
    res.status(401).json({ error: 'invalid_token' });
  }
}
