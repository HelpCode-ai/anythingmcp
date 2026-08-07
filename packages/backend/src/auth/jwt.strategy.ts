import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload, isForeignIssuedToken, isTokenRevoked } from './auth.service';
import { PrismaService } from '../common/prisma.service';
import { getRequiredSecret } from '../common/secrets.util';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getRequiredSecret(
        'JWT_SECRET',
        configService.get<string>('JWT_SECRET'),
      ),
    });
  }

  async validate(payload: JwtPayload) {
    // SECURITY: the MCP OAuth authorization server signs its access/refresh
    // tokens with the same JWT_SECRET as this strategy, so a valid signature
    // does not imply a dashboard token. Reject anything bearing the MCP-side
    // claims before it can be traded for a dashboard session.
    if (isForeignIssuedToken(payload as unknown as Record<string, unknown>)) {
      throw new UnauthorizedException('Token is not valid for this API');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    // Revocation: refuse tokens minted before the user's cutover instant (set
    // on password change, demotion, deprovisioning or an SSO config change).
    // Free to check — the user row is already loaded.
    if (isTokenRevoked(payload, user.sessionsValidFrom)) {
      throw new UnauthorizedException('Session has been revoked');
    }

    // Self-heal a NULL active org by snapping to the oldest remaining membership.
    // This happens when an organization the user was active in was deleted while
    // they were a member of others — schema's onDelete:SetNull leaves them dangling.
    if (user.organizationId === null) {
      const fallback = await this.prisma.organizationMember.findFirst({
        where: { userId: user.id },
        orderBy: { joinedAt: 'asc' },
      });
      if (fallback) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { organizationId: fallback.organizationId, role: fallback.role },
        });
        return { sub: user.id, email: user.email, role: fallback.role, organizationId: fallback.organizationId };
      }
    }

    return { sub: user.id, email: user.email, role: user.role, organizationId: user.organizationId };
  }
}
